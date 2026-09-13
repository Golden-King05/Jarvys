import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { fetchLidarTile } from "../lidarTiles.js";

export const lidarTilesRouter = Router();

// Unauthenticated, like every other map tile URL this app hits directly
// (OSM, Esri World Imagery, RainViewer) — this is public USGS terrain
// imagery, not user data, and a plain <img>/UrlTile request can't attach an
// Authorization header anyway.
lidarTilesRouter.get(
  "/:z/:x/:y.png",
  asyncHandler(async (req, res) => {
    const z = Number(req.params.z);
    const x = Number(req.params.x);
    const y = Number(req.params.y);
    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y) || z < 0 || z > 20) {
      return res.status(400).json({ error: "Invalid tile coordinates" });
    }

    const tile = await fetchLidarTile(z, x, y);
    res.setHeader("Content-Type", tile.contentType);
    // Terrain doesn't change; cache aggressively both client- and
    // proxy-side so repeat pans/zooms and app reloads don't re-fetch.
    res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    res.send(tile.body);
  })
);
