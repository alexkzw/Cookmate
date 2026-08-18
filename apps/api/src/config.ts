import { z } from "zod";

/**
 * Env is validated once at boot and never read via `process.env` elsewhere.
 * A missing key should crash on startup with a clear message, not produce a
 * confusing 500 on the first user request.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required — get one at console.anthropic.com"),
  // Sonnet is the default on eval evidence, not on vibes: with the repair
  // loop on it matched Opus at 36/36 for $0.0463 per passing recipe against
  // Opus's $0.0561. Switching without the repair loop would have been wrong —
  // bare Sonnet only managed 26/36. See README "Model selection".
  RECIPE_MODEL: z.string().default("claude-sonnet-5"),
  RECIPE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),

  PORT: z.coerce.number().int().default(8787),
  DATABASE_PATH: z.string().default("./data/cookmate.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DEV_ALLOW_ANONYMOUS: z
    .string()
    .default("0")
    .transform((v) => v === "1" || v.toLowerCase() === "true"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`Invalid environment configuration:\n${issues}\n\nCopy .env.example to .env and fill it in.`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

/**
 * The model's reasoning budget — a cost axis independent of model choice.
 *
 * Not to be confused with `CookRequest.effort` (`minimal | moderate | project`),
 * which is how much work the *cook* wants to do. Same word, unrelated concepts;
 * they're logged in separate columns for exactly that reason.
 */
export type ReasoningEffort = Config["RECIPE_EFFORT"];
