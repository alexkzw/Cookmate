import { z } from "zod";

/**
 * Env is validated once at boot and never read via `process.env` elsewhere.
 * A missing key should crash on startup with a clear message, not produce a
 * confusing 500 on the first user request.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required — get one at console.anthropic.com"),
  RECIPE_MODEL: z.string().default("claude-opus-5"),
  RECIPE_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),

  PORT: z.coerce.number().int().default(8787),
  DATABASE_PATH: z.string().default("./data/cookable.db"),
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
