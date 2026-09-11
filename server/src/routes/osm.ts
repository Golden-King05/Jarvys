import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { findOsmElementsInArea, OSM_CATEGORY_KEYS } from "../osm.js";

export const osmRouter = Router();
osmRouter.use(requireAuth);

const boxSchema = z.object({
  south: z.coerce.number().min(-90).max(90),
  west: z.coerce.number().min(-180).max(180),
  north: z.coerce.number().min(-90).max(90),
  east: z.coerce.number().min(-180).max(180),
  limit: z.coerce.number().min(1).max(300).optional(),
  // Comma-separated OSM keys (the Layers panel's OSM settings checklist) to
  // narrow the query instead of matching every named element — validated
  // against a closed allowlist since this ends up interpolated straight
  // into a raw Overpass query string.
  categories: z
    .string()
    .optional()
    .transform((v) => v?.split(",").filter(Boolean))
    .pipe(z.array(z.enum(OSM_CATEGORY_KEYS)).optional()),
});

// Backs the map's "OpenStreetMap" layer — the client calls this on demand
// (its "Query" button, not polled like flights/Wikipedia) with the current
// viewport bounds, and gets back every named OSM node/way/relation there for
// the user to browse and optionally import as their own point.
osmRouter.get(
  "/nearby",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = boxSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid bounding box" });
    }
    const { south, west, north, east, limit, categories } = parsed.data;
    const result = await findOsmElementsInArea({ south, west, north, east }, limit, categories);
    if ("error" in result) {
      return res.status(502).json({ error: result.error });
    }
    res.json(result);
  })
);
