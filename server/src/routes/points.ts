import { Router } from "express";
import { z } from "zod";
import { createMapPoint, deleteMapPoint, getDistinctTagKeys, getMapPoints, updateMapPoint, type PointTag } from "../db.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { importPointFromUrl } from "../pointImport.js";

export const pointsRouter = Router();
pointsRouter.use(requireAuth);

const tagSchema = z.object({
  key: z.string().min(1).max(40),
  value: z.string().min(1).max(100),
});

function toApiPoint(row: {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  icon: string;
  lat: number;
  lon: number;
  urls_json: string;
  blurb: string;
  source: string;
  tags_json: string;
  created_at: string;
}) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    subcategory: row.subcategory,
    icon: row.icon,
    lat: row.lat,
    lon: row.lon,
    urls: JSON.parse(row.urls_json) as string[],
    blurb: row.blurb,
    source: row.source,
    tags: JSON.parse(row.tags_json) as PointTag[],
    createdAt: row.created_at,
  };
}

pointsRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await getMapPoints(req.userId!);
    res.json({ points: rows.map(toApiPoint) });
  })
);

// Every tag header already in use across the account's points — powers the
// "pick an existing header" suggestion when adding a new tag, so headers
// naturally converge (e.g. everyone reusing "architecture") instead of
// drifting into near-duplicates. Nothing here enforces reuse, it just makes
// what already exists easy to see and pick.
pointsRouter.get(
  "/tags",
  asyncHandler(async (req: AuthedRequest, res) => {
    const keys = await getDistinctTagKeys(req.userId!);
    res.json({ keys });
  })
);

const createSchema = z.object({
  name: z.string().min(1).max(120),
  category: z.string().max(60).optional(),
  subcategory: z.string().max(60).optional(),
  icon: z.string().max(8).optional(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  urls: z.array(z.string().url()).max(10).optional(),
  blurb: z.string().max(4000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
});

// A user-placed pin — either tapped directly on the map or typed in by
// coordinates, always with a name they chose themselves.
pointsRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const point = await createMapPoint(req.userId!, { ...parsed.data, source: "manual" });
    res.json(toApiPoint(point));
  })
);

const importSchema = z.object({
  url: z.string().url(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  category: z.string().max(60).optional(),
  subcategory: z.string().max(60).optional(),
  icon: z.string().max(8).optional(),
});

// No name required here — it's inferred from the URL (the Wikipedia article
// title, or the page's <title> tag). Wikipedia articles about a real place
// carry their own coordinates; anything else needs lat/lon supplied, which
// the client gets by having the user tap the map first.
pointsRouter.post(
  "/from-url",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }

    const imported = await importPointFromUrl(parsed.data.url);
    if ("error" in imported) {
      return res.status(502).json({ error: imported.error });
    }

    const lat = parsed.data.lat ?? imported.lat;
    const lon = parsed.data.lon ?? imported.lon;
    if (lat == null || lon == null) {
      return res.status(422).json({
        error: "That link doesn't carry its own location — tap the map or enter coordinates to place it.",
        needsLocation: true,
        name: imported.name,
      });
    }

    const point = await createMapPoint(req.userId!, {
      name: imported.name,
      category: parsed.data.category ?? "",
      subcategory: parsed.data.subcategory ?? "",
      icon: parsed.data.icon ?? imported.icon,
      lat,
      lon,
      urls: imported.urls,
      blurb: imported.blurb,
      source: "import",
    });
    res.json(toApiPoint(point));
  })
);

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  category: z.string().max(60).optional(),
  subcategory: z.string().max(60).optional(),
  icon: z.string().max(8).optional(),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  urls: z.array(z.string().url()).max(10).optional(),
  blurb: z.string().max(4000).optional(),
  tags: z.array(tagSchema).max(20).optional(),
});

// Covers both the detail-form edit and a marker dragged to a new spot on
// the map (a lat/lon-only patch) — same endpoint either way.
pointsRouter.put(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
    }
    const updated = await updateMapPoint(req.userId!, req.params.id, parsed.data);
    if (!updated) {
      return res.status(404).json({ error: "Point not found" });
    }
    res.json(toApiPoint(updated));
  })
);

pointsRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const deleted = await deleteMapPoint(req.userId!, req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: "Point not found" });
    }
    res.json({ ok: true });
  })
);
