import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config.js";
import { chatRoutes } from "./routes/chat.js";
import { pantryRoutes } from "./routes/pantry.js";
import { feedbackRoutes } from "./routes/feedback.js";
import { statsRoutes } from "./routes/stats.js";
import { describeModel } from "./llm/models.js";
import "./db/index.js"; // run migrations at boot

const app = new Hono();

app.use("*", logger());
app.use(
  "/api/*",
  cors({
    origin: config.CORS_ORIGIN.split(",").map((s) => s.trim()),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  }),
);

app.get("/health", (c) => {
  const spec = describeModel(config.RECIPE_MODEL);
  return c.json({
    ok: true,
    model: config.RECIPE_MODEL,
    effort: config.RECIPE_EFFORT,
    tier: spec?.tier ?? "unknown",
    authMode: config.DEV_ALLOW_ANONYMOUS ? "dev-anonymous" : "supabase-jwt",
  });
});

app.route("/api/chat", chatRoutes);
app.route("/api/pantry", pantryRoutes);
app.route("/api/feedback", feedbackRoutes);
app.route("/api/stats", statsRoutes);

if (config.DEV_ALLOW_ANONYMOUS) {
  console.warn("⚠️  DEV_ALLOW_ANONYMOUS=1 — auth is bypassed. Never run this in production.");
}

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`cookmate api → http://localhost:${info.port}`);
  console.log(`  model: ${config.RECIPE_MODEL} (effort: ${config.RECIPE_EFFORT})`);
});
