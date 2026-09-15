import { Router } from "express";
import { z } from "zod";
import {
  applyOsmUploadResults,
  clearOsmEditorWorkingSet,
  createLocalOsmElement,
  deleteOsmElement,
  getOsmEditorElement,
  listDirtyOsmEditorElements,
  listOsmEditorElements,
  patchOsmElement,
  upsertDownloadedOsmElements,
  type OsmEditorElementRow,
  type OsmElementType,
  type OsmGeometry,
} from "../db.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";
import { checkAreaSize, downloadOsmEditorArea, type OsmEditorArea } from "../osmEditorOverpass.js";
import { getOsmTagDefinitions } from "../osmTagDefinitions.js";
import {
  buildOsmChangeXml,
  closeChangeset,
  createChangeset,
  parseDiffResult,
  uploadChangeset,
  type OsmTarget,
} from "../osmEditorUpload.js";

export const osmEditorRouter = Router();
osmEditorRouter.use(requireAuth);

function toApiElement(row: OsmEditorElementRow) {
  return {
    type: row.el_type,
    id: row.el_id,
    version: row.version,
    action: row.action,
    tags: JSON.parse(row.tags_json) as Record<string, string>,
    geometry: JSON.parse(row.geometry_json) as OsmGeometry,
  };
}

// The app's own point-tags editor (TagsEditor.tsx) is reused here for OSM
// elements too — it just needs the same TagDefinition[] shape, sourced from
// Taginfo instead of the hand-maintained spreadsheet.
osmEditorRouter.get(
  "/tag-definitions",
  asyncHandler(async (_req: AuthedRequest, res) => {
    const definitions = await getOsmTagDefinitions();
    res.json({ definitions });
  })
);

osmEditorRouter.get(
  "/elements",
  asyncHandler(async (req: AuthedRequest, res) => {
    const rows = await listOsmEditorElements(req.userId!);
    res.json({ elements: rows.map(toApiElement) });
  })
);

const pointSchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const bboxAreaSchema = z.object({
  kind: z.literal("bbox"),
  south: z.number().min(-90).max(90),
  west: z.number().min(-180).max(180),
  north: z.number().min(-90).max(90),
  east: z.number().min(-180).max(180),
});
const polygonAreaSchema = z.object({
  kind: z.literal("polygon"),
  points: z.array(pointSchema).min(3).max(500),
});
const areaSchema = z.union([bboxAreaSchema, polygonAreaSchema]);

// Downloads real OSM data inside a drawn boundary (or a plain bbox) via
// Overpass and merges it into the user's working set — called again with a
// different area to "expand selection" (the merge itself, in
// upsertDownloadedOsmElements, is what makes that safe: it never disturbs
// an element already being edited).
osmEditorRouter.post(
  "/download",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = areaSchema.safeParse(req.body?.area);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid area" });
    }
    const area = parsed.data as OsmEditorArea;
    const sizeCheck = checkAreaSize(area);
    if ("error" in sizeCheck) {
      return res.status(400).json({ error: sizeCheck.error });
    }
    const result = await downloadOsmEditorArea(area);
    if ("error" in result) {
      return res.status(502).json({ error: result.error });
    }
    await upsertDownloadedOsmElements(req.userId!, result.elements);
    const rows = await listOsmEditorElements(req.userId!);
    res.json({
      elements: rows.map(toApiElement),
      downloadedCount: result.elements.length,
      truncated: result.truncated,
    });
  })
);

const elementTypeSchema = z.enum(["node", "way", "relation"]);
const tagsSchema = z.record(z.string(), z.string()).optional();

const nodeGeometrySchema = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) });
const wayGeometrySchema = z.object({ nodeIds: z.array(z.number().int()) });
const relationGeometrySchema = z.object({
  members: z
    .array(z.object({ type: elementTypeSchema, ref: z.number().int(), role: z.string().max(60) }))
    .max(2000),
});

function validateGeometry(type: OsmElementType, geometry: unknown): OsmGeometry | null {
  if (type === "node") {
    const parsed = nodeGeometrySchema.safeParse(geometry);
    return parsed.success ? parsed.data : null;
  }
  if (type === "way") {
    const parsed = wayGeometrySchema.safeParse(geometry);
    return parsed.success ? parsed.data : null;
  }
  const parsed = relationGeometrySchema.safeParse(geometry);
  return parsed.success ? parsed.data : null;
}

const createElementSchema = z.object({
  type: elementTypeSchema,
  tags: tagsSchema,
  geometry: z.unknown(),
});

// A brand-new node/way/relation drawn locally — gets a negative placeholder
// id until it's uploaded.
osmEditorRouter.post(
  "/elements",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createElementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid element" });
    }
    const geometry = validateGeometry(parsed.data.type, parsed.data.geometry);
    if (!geometry) {
      return res.status(400).json({ error: `Invalid geometry for a ${parsed.data.type}` });
    }
    const row = await createLocalOsmElement(req.userId!, parsed.data.type, parsed.data.tags ?? {}, geometry);
    res.json(toApiElement(row));
  })
);

const patchElementSchema = z.object({
  tags: tagsSchema,
  geometry: z.unknown().optional(),
});

// Covers a tag edit, a node dragged to a new spot, and a way's node list or
// a relation's member list being changed — same endpoint either way.
osmEditorRouter.patch(
  "/elements/:type/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const typeParsed = elementTypeSchema.safeParse(req.params.type);
    const idParsed = z.coerce.number().int().safeParse(req.params.id);
    if (!typeParsed.success || !idParsed.success) {
      return res.status(400).json({ error: "Invalid element type or id" });
    }
    const bodyParsed = patchElementSchema.safeParse(req.body);
    if (!bodyParsed.success) {
      return res.status(400).json({ error: bodyParsed.error.issues[0]?.message ?? "Invalid patch" });
    }
    let geometry: OsmGeometry | undefined;
    if (bodyParsed.data.geometry !== undefined) {
      const validated = validateGeometry(typeParsed.data, bodyParsed.data.geometry);
      if (!validated) {
        return res.status(400).json({ error: `Invalid geometry for a ${typeParsed.data}` });
      }
      geometry = validated;
    }
    const updated = await patchOsmElement(req.userId!, typeParsed.data, idParsed.data, {
      tags: bodyParsed.data.tags,
      geometry,
    });
    if (!updated) {
      return res.status(404).json({ error: "Element not found" });
    }
    res.json(toApiElement(updated));
  })
);

osmEditorRouter.delete(
  "/elements/:type/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const typeParsed = elementTypeSchema.safeParse(req.params.type);
    const idParsed = z.coerce.number().int().safeParse(req.params.id);
    if (!typeParsed.success || !idParsed.success) {
      return res.status(400).json({ error: "Invalid element type or id" });
    }
    const result = await deleteOsmElement(req.userId!, typeParsed.data, idParsed.data);
    if (!result) {
      return res.status(404).json({ error: "Element not found" });
    }
    res.json({ ok: true, removed: result === "removed" });
  })
);

// Clears the entire local working set — a "start over" escape hatch. Never
// touches real OpenStreetMap data (nothing here has been uploaded), it just
// forgets what's been downloaded/drafted locally.
osmEditorRouter.delete(
  "/elements",
  asyncHandler(async (req: AuthedRequest, res) => {
    await clearOsmEditorWorkingSet(req.userId!);
    res.json({ ok: true });
  })
);

const uploadSchema = z.object({
  target: z.enum(["sandbox", "production"]).default("sandbox"),
  comment: z.string().min(1).max(255),
});

// Orchestrates the full OSM API v0.6 changeset flow (create -> upload ->
// close) for every pending edit in the working set. The user's OSM OAuth2
// access token is relayed per-request via X-OSM-Token — never persisted
// server-side. Transactional on OSM's end: the upload either fully applies
// or fully rejects (e.g. a 409 version conflict), so on any failure local
// DB state is left completely untouched and the error is surfaced as-is.
osmEditorRouter.post(
  "/upload",
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = uploadSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid upload request" });
    }
    const token = req.header("x-osm-token");
    if (!token) {
      return res.status(401).json({ error: "Missing OpenStreetMap access token — log in to OpenStreetMap first." });
    }
    const target: OsmTarget = parsed.data.target;

    const batch = await listDirtyOsmEditorElements(req.userId!);
    if (batch.length === 0) {
      return res.status(400).json({ error: "Nothing to upload — no pending edits." });
    }

    const changesetResult = await createChangeset(target, token, parsed.data.comment);
    if ("error" in changesetResult) {
      return res.status(502).json({ error: changesetResult.error });
    }
    const { changesetId } = changesetResult;

    const osmChangeXml = buildOsmChangeXml(changesetId, batch);
    const uploadResult = await uploadChangeset(target, token, changesetId, osmChangeXml);
    if ("error" in uploadResult) {
      // Best-effort close of the now-pointless (empty) changeset — doesn't
      // affect the error already being returned either way.
      await closeChangeset(target, token, changesetId).catch(() => {});
      return res.status(502).json({ error: uploadResult.error });
    }

    const mappings = parseDiffResult(uploadResult.diffXml);
    await closeChangeset(target, token, changesetId).catch(() => {});

    const deleted = batch.filter((r) => r.action === "delete").map((r) => ({ type: r.el_type, id: r.el_id }));
    await applyOsmUploadResults(req.userId!, batch, mappings, deleted);

    res.json({
      ok: true,
      changesetId,
      target,
      created: batch.filter((r) => r.action === "create").length,
      modified: batch.filter((r) => r.action === "modify").length,
      deleted: deleted.length,
    });
  })
);

// Kept for symmetry/debugging — not used by the normal editor flow, which
// always fetches the whole working set at once.
osmEditorRouter.get(
  "/elements/:type/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const typeParsed = elementTypeSchema.safeParse(req.params.type);
    const idParsed = z.coerce.number().int().safeParse(req.params.id);
    if (!typeParsed.success || !idParsed.success) {
      return res.status(400).json({ error: "Invalid element type or id" });
    }
    const row = await getOsmEditorElement(req.userId!, typeParsed.data, idParsed.data);
    if (!row) return res.status(404).json({ error: "Element not found" });
    res.json(toApiElement(row));
  })
);
