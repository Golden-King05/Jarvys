import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { clusterArticles, findArticlesInArea } from "../wikipedia.js";

export const wikipediaRouter = Router();
wikipediaRouter.use(requireAuth);

const boxSchema = z.object({
  south: z.coerce.number().min(-90).max(90),
  west: z.coerce.number().min(-180).max(180),
  north: z.coerce.number().min(-90).max(90),
  east: z.coerce.number().min(-180).max(180),
  limit: z.coerce.number().min(1).max(100).optional(),
});

// Backs the map's "Wikipedia" layer — the client polls this with its
// current viewport bounds and gets back geotagged articles pre-clustered
// by proximity, ready to render as pins.
wikipediaRouter.get(
  "/nearby",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = boxSchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid bounding box" });
    }
    const { south, west, north, east, limit } = parsed.data;
    const { articles, areaTooLarge } = await findArticlesInArea({ south, west, north, east }, limit ?? 60);
    res.json({ clusters: clusterArticles(articles), areaTooLarge });
  })
);
