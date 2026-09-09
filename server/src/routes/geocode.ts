import { Router } from "express";
import { z } from "zod";
import { geocode } from "../geo.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const geocodeRouter = Router();
geocodeRouter.use(requireAuth);

const querySchema = z.object({ q: z.string().min(1).max(200) });

// Backs the map's search bar — a direct "find this place" lookup, separate
// from the AI chat tools that also geocode internally.
geocodeRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid query" });
    }
    const result = await geocode(parsed.data.q);
    if ("error" in result) {
      return res.status(404).json({ error: result.error });
    }
    res.json(result);
  })
);
