import { Hono } from "hono";
import { z } from "zod";
import { EquipmentSchema } from "@cookmate/shared";
import { requireAuth } from "../auth.js";
import { getPantry, setPantry, getPreferences, setPreferences } from "../db/index.js";

export const pantryRoutes = new Hono();

pantryRoutes.get("/", requireAuth, (c) => {
  const user = c.get("user");
  return c.json({ pantry: getPantry(user.id), ...getPreferences(user.id) });
});

const UpdateSchema = z
  .object({
    // Bounds mirror CookRequestSchema in @cookmate/shared — keep them in step,
    // or a value the client can save becomes one the generator rejects.
    pantry: z.array(z.string().min(1).max(120)).max(200).optional(),
    dislikes: z.array(z.string().min(1).max(120)).max(100).optional(),
    dietary: z.array(z.string().min(1).max(120)).max(20).optional(),
    // Enum-validated, so an unknown appliance is a 400 rather than a value
    // that silently never matches anything in the verifier.
    cookware: z.array(EquipmentSchema).max(40).optional(),
  })
  .strict();

pantryRoutes.put("/", requireAuth, async (c) => {
  const user = c.get("user");
  const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid payload", issues: parsed.error.issues }, 400);
  }

  if (parsed.data.pantry) setPantry(user.id, parsed.data.pantry);
  if (parsed.data.dislikes || parsed.data.dietary || parsed.data.cookware) {
    const current = getPreferences(user.id);
    setPreferences(user.id, {
      dislikes: parsed.data.dislikes ?? current.dislikes,
      dietary: parsed.data.dietary ?? current.dietary,
      cookware: parsed.data.cookware ?? current.cookware,
    });
  }

  return c.json({ pantry: getPantry(user.id), ...getPreferences(user.id) });
});
