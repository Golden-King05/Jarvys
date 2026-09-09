import { Router } from "express";
import { z } from "zod";
import { flightToMapPoint, getFlightsInBoundingBox } from "../flights.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const flightsRouter = Router();
flightsRouter.use(requireAuth);

const boxSchema = z.object({
  south: z.coerce.number().min(-90).max(90),
  west: z.coerce.number().min(-180).max(180),
  north: z.coerce.number().min(-90).max(90),
  east: z.coerce.number().min(-180).max(180),
});

// Backs the map's "Live flights" layer — the client polls this with its
// current viewport bounds and gets back ready-to-render points, the same
// shape as every other map result.
flightsRouter.get("/", async (req: AuthedRequest, res) => {
  const parsed = boxSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid bounding box" });
  }
  const flights = await getFlightsInBoundingBox(parsed.data);
  if ("error" in flights) {
    return res.status(502).json({ error: flights.error });
  }
  res.json({ points: flights.map(flightToMapPoint) });
});
