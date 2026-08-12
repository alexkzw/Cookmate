import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Flat config (ESLint 9). The root `lint` script referenced a config that never
 * existed, so `pnpm lint` failed — and CI can't enforce what it can't run.
 *
 * Deliberately the non-type-checked preset: it needs no tsconfig project wiring
 * and runs in seconds. `tsc --noEmit` already covers type correctness across all
 * three packages, so the job here is the things the compiler doesn't care about
 * — unused bindings, unreachable code, accidental globals.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // The API runs in Node: filesystem, process, console.
  {
    files: ["apps/api/**/*.ts"],
    languageOptions: { globals: { ...globals.node } },
  },

  // The web app runs in a browser: window, document, fetch. No Node globals —
  // if a browser file reaches for `process`, that should be an error here.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
  },

  // Config files at the repo root are Node modules too.
  {
    files: ["*.js", "*.config.js", "apps/*/*.config.{js,ts}"],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    rules: {
      // A leading underscore is the conventional "deliberately unused" marker —
      // used by discarded callback args and destructured rest patterns.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
);
