import { Hono } from "hono";
import { z } from "zod";
import { requireAuth } from "../auth.js";
import { getPantry, setPantry, getPreferences, setPreferences } from "../db/index.js";

export const pantryRoutes = new Hono();

pantryRoutes.get("/", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ pantry: getPantry(user.id), ...getPreferences(user.id) });
});

const UpdateSchema = z
  .object({
    pantry: z.array(z.string().min(1).max(80)).max(200).optional(),
    dislikes: z.array(z.string().min(1).max(80)).max(100).optional(),
    dietary: z.array(z.string().min(1).max(80)).max(20).optional(),
  })
  .strict();

pantryRoutes.put("/", requireAuth, async (c) => {
  const user = c.get("user");
  const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  if (parsed.data.pantry) setPantry(user.id, parsed.data.pantry);
  if (parsed.data.dislikes || parsed.data.dietary) {
    const current = getPreferences(user.id);
    setPreferences(user.id, {
      dislikes: parsed.data.dislikes ?? current.dislikes,
      dietary: parsed.data.dietary ?? current.dietary,
    });
  }

  return c.json({ pantry: getPantry(user.id), ...getPreferences(user.id) });
});
