import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Context, Next } from "hono";
import { config } from "./config.js";
import { upsertUser } from "./db/index.js";

/**
 * Supabase issues the Google OAuth flow and hands the browser a JWT. We do not
 * run our own session store — we just verify that JWT on every request.
 *
 * Why Supabase for auth but SQLite for data: the OAuth dance (consent screen,
 * callback, token refresh, revocation) is genuinely fiddly and entirely
 * undifferentiated work. The recipe data is the opposite — it's the part worth
 * owning. So we rent the auth and keep the data.
 *
 * Verification uses the project's JWKS endpoint, so no shared secret lives in
 * this codebase and key rotation is handled for us.
 */

export interface AuthedUser {
  id: string;
  email: string | null;
  displayName: string | null;
}

declare module "hono" {
  interface ContextVariableMap {
    user: AuthedUser;
  }
}

const jwks = config.SUPABASE_JWKS_URL
  ? createRemoteJWKSet(new URL(config.SUPABASE_JWKS_URL))
  : null;

/** Stable pseudo-user for local development, so you can build without OAuth. */
const DEV_USER: AuthedUser = {
  id: "dev-local-user",
  email: "dev@localhost",
  displayName: "Local Dev",
};

export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (config.DEV_ALLOW_ANONYMOUS) {
    upsertUser(DEV_USER.id, DEV_USER.email, DEV_USER.displayName);
    c.set("user", DEV_USER);
    return next();
  }

  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing bearer token" }, 401);
  }
  if (!jwks) {
    return c.json({ error: "Auth is not configured on this server" }, 500);
  }

  const token = header.slice("Bearer ".length);
  try {
    const { payload } = await jwtVerify(token, jwks, {
      // Supabase mints tokens for the 'authenticated' audience.
      audience: "authenticated",
    });

    const id = typeof payload.sub === "string" ? payload.sub : null;
    if (!id) return c.json({ error: "Token has no subject" }, 401);

    const email = typeof payload.email === "string" ? payload.email : null;
    const meta = (payload.user_metadata ?? {}) as Record<string, unknown>;
    const displayName =
      typeof meta.full_name === "string"
        ? meta.full_name
        : typeof meta.name === "string"
          ? meta.name
          : null;

    upsertUser(id, email, displayName);
    c.set("user", { id, email, displayName });
    return next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
