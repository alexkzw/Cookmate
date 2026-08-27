# syntax=docker/dockerfile:1

# =====================================================================
# WHY A CONTAINER AT ALL
#
# "It works on my machine" is a statement about your machine, not your
# software. A container makes the machine part of the artifact: the OS, the
# Node version, the native modules compiled against that exact libc, and the
# file layout all ship together. The thing tested in CI is then bit-identical
# to the thing running in production, because it IS the thing — not a rebuild
# of it from the same source, which is a weaker guarantee than it sounds.
#
# For this app there is a second, sharper reason. `better-sqlite3` is a NATIVE
# module: it compiles C++ against the platform it is installed on. A build on
# an Intel Mac produces a binary that will not load on a Linux ARM server. The
# container removes the question entirely by building on the target platform.
#
# THE STAGES BELOW, AND WHY THERE IS MORE THAN ONE
#
#   builder  full toolchain — compilers, dev dependencies, TypeScript.
#   runner   the runtime, holding only what is needed to serve a request.
#
# The split exists because a build needs things a server must never have. gcc,
# python3 and the TypeScript compiler are all attack surface once the container
# is reachable from the internet, and the source code itself is an asset you
# would rather not ship. Multi-stage builds let the compiler exist for exactly
# as long as it is useful and then get discarded — only the files explicitly
# COPY'd out of `builder` survive into the final image.
# =====================================================================


# ---------------------------------------------------------------------
# STAGE 1 — builder
# ---------------------------------------------------------------------
# `-slim` rather than the default: the full image is ~1.1GB of Debian with a
# toolchain we mostly do not want. `-alpine` would be smaller still, but Alpine
# uses musl instead of glibc and native modules are a recurring source of
# subtle breakage there. Slim is the boring, correct default.
#
# The Node version is PINNED to a major. `node:latest` means a silent runtime
# upgrade lands the next time anyone rebuilds — a change to the most
# load-bearing dependency you have, made by nobody, recorded nowhere.
FROM node:22-slim AS builder

# better-sqlite3 has no prebuilt binary for every platform and falls back to
# compiling from source. These are what node-gyp needs to do that. They exist
# ONLY in this stage — see the note above about not shipping a compiler.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# corepack ships with Node and reads `packageManager` from package.json, so the
# pnpm version used here can never drift from the one used locally. Pinning the
# package manager matters more than it looks: pnpm resolves the lockfile, and
# two versions can legitimately produce different trees from the same file.
RUN corepack enable

WORKDIR /app

# ---- Dependency layer -----------------------------------------------
# Manifests are copied BEFORE the source, on purpose. Docker caches each layer
# and invalidates everything downstream of the first file that changed — so
# copying source first would re-run `pnpm install` on every one-line edit.
# Copying manifests first means the install layer is reused until a dependency
# actually changes, turning a ~90 second rebuild into a ~5 second one.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/

# `--frozen-lockfile` fails the build if the lockfile and manifests disagree,
# rather than silently resolving something new. In CI that is the difference
# between a reproducible build and one that quietly picks up a fresh minor
# version of a transitive dependency at 3am.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---- Source layer ---------------------------------------------------
COPY . .

# Build order matters and pnpm handles it: `pnpm -r build` walks the workspace
# in topological order, so `@cookmate/shared` compiles before the API and the
# web app that import it.
#
# This is the step that was silently broken before deployment was attempted.
# `packages/shared` exported raw .ts, so `tsc` was happy and `node dist/index.js`
# was not — Node cannot execute TypeScript. The build passed for months while
# producing an artifact that could not start, because nothing ever ran the
# artifact. Building a container is what forced the artifact to be run.
RUN pnpm -r build

# Compute the scorer hash HERE, where the sources still exist, and write it to a
# file the runtime stage copies. The runtime image ships compiled JS only, so
# `verify/provenance.ts` has nothing to hash there — without this, production
# would report `scorerHash: "unknown"` and the one number that ties a live
# recipe verdict back to a trusted eval run would be missing in production and
# present everywhere else.
RUN pnpm --filter @cookmate/api exec tsx scripts/print-scorer-hash.ts > /app/.scorer-hash

# ---- Produce a self-contained production tree -----------------------
# The install above deliberately included devDependencies — TypeScript, Vite and
# vitest are what produced the build. None is needed to SERVE a request, and
# every one is weight and attack surface in the final image.
#
# `pnpm deploy` is the tool for this and it solves a problem specific to pnpm
# monorepos. pnpm's node_modules is a SYMLINK FARM: each package's dependencies
# are links into a shared content-addressed store at the workspace root. That is
# what makes installs fast locally, and it is exactly what does not survive
# being copied piecemeal into another image stage — the links resolve to paths
# that no longer exist, and the container dies at startup with
# ERR_MODULE_NOT_FOUND on its very first import.
#
# `deploy` walks one package's real dependency graph and writes a FLAT, fully
# materialised directory with no links out of it. `--prod` drops
# devDependencies, and `--legacy` is required under pnpm 10 unless the workspace
# opts into injected dependencies.
#
# (`pnpm prune --prod` looks like the obvious alternative and is a trap here: at
# the workspace root it leaves each package's own node_modules empty, so the
# image builds cleanly and then cannot resolve its first import.)
RUN pnpm --filter=@cookmate/api deploy --prod --legacy /prod/api

# Stamped into the image so `/version` can answer "which code is this?" without
# anyone guessing. Passed in by CI; defaults keep a local build honest.
ARG GIT_SHA=local
ARG BUILD_TIME=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}


# ---------------------------------------------------------------------
# STAGE 2 — runner
# ---------------------------------------------------------------------
FROM node:22-slim AS runner

# `tini` is a 10KB init process, and it fixes a real problem. A container's
# main process runs as PID 1, and PID 1 in Linux has special semantics: it does
# not get the default signal handlers, and it is responsible for reaping
# orphaned child processes. Node as PID 1 therefore ignores SIGTERM unless the
# app handles it explicitly — which turns every deploy into a 30-second wait
# followed by SIGKILL. This app DOES handle SIGTERM (see src/index.ts), but
# tini also guarantees signals reach it correctly and cleans up zombies, and it
# costs nothing.
RUN apt-get update && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# ---- Run as a non-root user -----------------------------------------
# Containers run as root by default, which means a remote-code-execution bug in
# the app is root inside the container — and with a kernel escape, closer to
# root on the host than anyone wants. The `node` image already ships an
# unprivileged `node` user, so this is one line for a meaningful reduction in
# blast radius. Most enterprise container policies REQUIRE it, and a Dockerfile
# without it is the first thing a security review flags.
#
# The data directory is created and chowned here because a non-root process
# cannot create a directory at the root of the filesystem at runtime — a
# mistake that surfaces as a confusing SQLITE_CANTOPEN on first boot.
RUN mkdir -p /app/data && chown -R node:node /app

# One directory, already flattened and production-only. Nothing to reassemble.
COPY --from=builder --chown=node:node /prod/api ./apps/api
# The built React bundle, served by the API from ./public — one origin, one
# deploy, and therefore no CORS in production. See src/index.ts.
COPY --from=builder --chown=node:node /app/apps/web/dist ./apps/api/public
COPY --from=builder --chown=node:node /app/.scorer-hash ./.scorer-hash

ARG GIT_SHA=local
ARG BUILD_TIME=unknown
ENV GIT_SHA=${GIT_SHA}
ENV BUILD_TIME=${BUILD_TIME}

USER node

# Documentation, not configuration: EXPOSE does not publish anything. It records
# the contract for whoever runs the image, and some tooling reads it.
EXPOSE 8787

# The container's own liveness check. Distinct from the platform's — this one
# lets `docker ps` show health locally and lets Compose gate `depends_on`.
# Points at /health (liveness) rather than /ready, because a failing check here
# should mean "restart me", which is exactly what /health is for.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

WORKDIR /app/apps/api

# ENTRYPOINT + CMD, not a shell string. The exec form means Node is the process
# that receives SIGTERM. Writing `CMD "node dist/index.js"` wraps it in
# /bin/sh -c, and the shell does not forward signals to its child — so the
# graceful shutdown code would never run and every deploy would hard-kill
# in-flight recipe generations.
ENTRYPOINT ["/usr/bin/tini", "--"]
# The scorer hash is read from the file the builder wrote and exported into the
# environment before Node starts. A tiny shell wrapper rather than a build ARG
# because the value is only known after `pnpm -r build` has run.
CMD ["sh", "-c", "SCORER_HASH=$(cat /app/.scorer-hash) exec node dist/index.js"]
