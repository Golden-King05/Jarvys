import { createClient, type Client } from "@libsql/client";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Local dev: a plain SQLite file (e.g. "file:./data/jarvys.db").
// Hosted: a Turso database URL ("libsql://...") + DATABASE_AUTH_TOKEN.
// Same client, same SQL, either way.
const url = process.env.DATABASE_URL ?? "file:./data/jarvys.db";

if (url.startsWith("file:")) {
  const filePath = url.slice("file:".length);
  fs.mkdirSync(path.dirname(filePath) || ".", { recursive: true });
}

export const db: Client = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

await db.executeMultiple(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assistant_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    assistant_name TEXT NOT NULL DEFAULT 'Jarvys',
    instructions TEXT NOT NULL DEFAULT '',
    preferences_json TEXT NOT NULL DEFAULT '{}',
    preferred_provider TEXT NOT NULL DEFAULT 'groq',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
    ON chat_messages(user_id, created_at);

  -- Gemini doesn't return remaining-quota headers the way Groq does, so we
  -- track our own call count per UTC day to show a comparable "X left
  -- today" figure once a conversation is running on Gemini.
  CREATE TABLE IF NOT EXISTS provider_usage (
    provider TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, usage_date)
  );

  -- Every pin on the map, whether the user placed it, imported it from a
  -- URL, or the assistant found it via a search tool. dedupe_key stops a
  -- repeated search from re-saving the same spot over and over.
  CREATE TABLE IF NOT EXISTS map_points (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    subcategory TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '📍',
    lat REAL NOT NULL,
    lon REAL NOT NULL,
    urls_json TEXT NOT NULL DEFAULT '[]',
    blurb TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual',
    tags_json TEXT NOT NULL DEFAULT '[]',
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, dedupe_key)
  );

  CREATE INDEX IF NOT EXISTS idx_map_points_user ON map_points(user_id);

  -- The JLOSME editor's working set: every OSM node/way/relation the user
  -- has downloaded (via Overpass) or created locally, plus their pending
  -- edits. Addressed by (user_id, el_type, el_id) rather than a fresh UUID
  -- since OSM elements are already identified that way — el_id is the real
  -- OSM id once known, or a locally-assigned negative placeholder for
  -- something created here and never yet uploaded.
  CREATE TABLE IF NOT EXISTS osm_editor_elements (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    el_type TEXT NOT NULL,
    el_id INTEGER NOT NULL,
    version INTEGER,
    action TEXT NOT NULL DEFAULT 'none',
    tags_json TEXT NOT NULL DEFAULT '{}',
    geometry_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, el_type, el_id)
  );

  CREATE INDEX IF NOT EXISTS idx_osm_editor_elements_user ON osm_editor_elements(user_id);
`);

// chat_messages predates map_data_json/tools_used_json/tools_failed_json —
// add them for databases created before these columns existed. SQLite has
// no "ADD COLUMN IF NOT EXISTS", so ignore the one error that means it's
// already there.
for (const column of ["map_data_json", "tools_used_json", "tools_failed_json"]) {
  try {
    await db.execute(`ALTER TABLE chat_messages ADD COLUMN ${column} TEXT`);
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
  }
}

// assistant_settings predates preferred_provider — same deal.
try {
  await db.execute("ALTER TABLE assistant_settings ADD COLUMN preferred_provider TEXT NOT NULL DEFAULT 'groq'");
} catch (err) {
  if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
}

// map_points predates tags_json — same deal.
try {
  await db.execute("ALTER TABLE map_points ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
} catch (err) {
  if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
}

export async function incrementProviderUsage(provider: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  await db.execute({
    sql: `INSERT INTO provider_usage (provider, usage_date, count) VALUES (?, ?, 1)
          ON CONFLICT(provider, usage_date) DO UPDATE SET count = count + 1`,
    args: [provider, today],
  });
  const result = await db.execute({
    sql: "SELECT count FROM provider_usage WHERE provider = ? AND usage_date = ?",
    args: [provider, today],
  });
  return Number((result.rows[0] as unknown as { count: number } | undefined)?.count ?? 0);
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface AssistantSettingsRow {
  user_id: string;
  assistant_name: string;
  instructions: string;
  preferences_json: string;
  preferred_provider: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  map_data_json: string | null;
  tools_used_json: string | null;
  tools_failed_json: string | null;
  created_at: string;
}

// A structured label on a point — a header (e.g. "architecture") and a value
// (e.g. "Victorian") rather than one free-text field, so the same header
// naturally accumulates consistent values across points instead of drifting
// into near-duplicate headers like "architecture" vs "building_architecture".
export interface PointTag {
  key: string;
  value: string;
}

export interface MapPointRow {
  id: string;
  user_id: string;
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
  dedupe_key: string;
  created_at: string;
}

export interface NewMapPoint {
  name: string;
  category?: string;
  subcategory?: string;
  icon?: string;
  lat: number;
  lon: number;
  urls?: string[];
  blurb?: string;
  source?: string;
  tags?: PointTag[];
}

function dedupeKeyFor(name: string, lat: number, lon: number): string {
  return `${lat.toFixed(4)}|${lon.toFixed(4)}|${name.trim().toLowerCase()}`;
}

export async function getMapPoints(userId: string): Promise<MapPointRow[]> {
  const result = await db.execute({
    sql: "SELECT * FROM map_points WHERE user_id = ? ORDER BY created_at ASC",
    args: [userId],
  });
  return result.rows as unknown as MapPointRow[];
}

// Lets the assistant check whether the user already has a saved point for a
// place before answering a question about it (use it as a source) or before
// proposing a new one (avoid suggesting a duplicate).
export async function findMapPointsByName(userId: string, query: string, limit = 5): Promise<MapPointRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM map_points WHERE user_id = ? AND LOWER(name) LIKE LOWER(?)
          ORDER BY created_at DESC LIMIT ?`,
    args: [userId, `%${query}%`, limit],
  });
  return result.rows as unknown as MapPointRow[];
}

// A user-initiated add (manual pin or URL import) — overwrites an existing
// point at the same dedupe key, since re-adding the same spot on purpose
// means the user wants today's details to win.
export async function createMapPoint(userId: string, point: NewMapPoint): Promise<MapPointRow> {
  const id = randomUUID();
  const dedupeKey = dedupeKeyFor(point.name, point.lat, point.lon);
  await db.execute({
    sql: `INSERT INTO map_points (id, user_id, name, category, subcategory, icon, lat, lon, urls_json, blurb, source, tags_json, dedupe_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, dedupe_key) DO UPDATE SET
            name = excluded.name, category = excluded.category, subcategory = excluded.subcategory,
            icon = excluded.icon, urls_json = excluded.urls_json, blurb = excluded.blurb, source = excluded.source,
            tags_json = excluded.tags_json`,
    args: [
      id,
      userId,
      point.name,
      point.category ?? "",
      point.subcategory ?? "",
      point.icon ?? "📍",
      point.lat,
      point.lon,
      JSON.stringify(point.urls ?? []),
      point.blurb ?? "",
      point.source ?? "manual",
      JSON.stringify(point.tags ?? []),
      dedupeKey,
    ],
  });
  const result = await db.execute({
    sql: "SELECT * FROM map_points WHERE user_id = ? AND dedupe_key = ?",
    args: [userId, dedupeKey],
  });
  return result.rows[0] as unknown as MapPointRow;
}

// The assistant's own search results back themselves up here automatically —
// silently skipping a spot that's already saved instead of overwriting it,
// so it never clobbers a blurb the user edited by hand.
export async function saveMapPointsFromSearch(userId: string, points: NewMapPoint[]): Promise<void> {
  for (const point of points) {
    await db.execute({
      sql: `INSERT INTO map_points (id, user_id, name, category, subcategory, icon, lat, lon, urls_json, blurb, source, tags_json, dedupe_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, dedupe_key) DO NOTHING`,
      args: [
        randomUUID(),
        userId,
        point.name,
        point.category ?? "",
        point.subcategory ?? "",
        point.icon ?? "📍",
        point.lat,
        point.lon,
        JSON.stringify(point.urls ?? []),
        point.blurb ?? "",
        point.source ?? "search",
        JSON.stringify(point.tags ?? []),
        dedupeKeyFor(point.name, point.lat, point.lon),
      ],
    });
  }
}

export async function deleteMapPoint(userId: string, id: string): Promise<boolean> {
  const result = await db.execute({
    sql: "DELETE FROM map_points WHERE id = ? AND user_id = ?",
    args: [id, userId],
  });
  return result.rowsAffected > 0;
}

export interface UpdateMapPoint {
  name?: string;
  category?: string;
  subcategory?: string;
  icon?: string;
  lat?: number;
  lon?: number;
  urls?: string[];
  blurb?: string;
  tags?: PointTag[];
}

// Covers both edits from the detail form and a marker dragged to a new spot
// (just a lat/lon-only patch) — same endpoint either way.
export async function updateMapPoint(
  userId: string,
  id: string,
  patch: UpdateMapPoint
): Promise<MapPointRow | null> {
  const current = await db.execute({
    sql: "SELECT * FROM map_points WHERE id = ? AND user_id = ?",
    args: [id, userId],
  });
  const row = current.rows[0] as unknown as MapPointRow | undefined;
  if (!row) return null;

  const next = {
    name: patch.name ?? row.name,
    category: patch.category ?? row.category,
    subcategory: patch.subcategory ?? row.subcategory,
    icon: patch.icon ?? row.icon,
    lat: patch.lat ?? row.lat,
    lon: patch.lon ?? row.lon,
    urls_json: patch.urls ? JSON.stringify(patch.urls) : row.urls_json,
    blurb: patch.blurb ?? row.blurb,
    tags_json: patch.tags ? JSON.stringify(patch.tags) : row.tags_json,
  };

  await db.execute({
    sql: `UPDATE map_points
          SET name = ?, category = ?, subcategory = ?, icon = ?, lat = ?, lon = ?, urls_json = ?, blurb = ?, tags_json = ?, dedupe_key = ?
          WHERE id = ? AND user_id = ?`,
    args: [
      next.name,
      next.category,
      next.subcategory,
      next.icon,
      next.lat,
      next.lon,
      next.urls_json,
      next.blurb,
      next.tags_json,
      dedupeKeyFor(next.name, next.lat, next.lon),
      id,
      userId,
    ],
  });

  const updated = await db.execute({ sql: "SELECT * FROM map_points WHERE id = ?", args: [id] });
  return updated.rows[0] as unknown as MapPointRow;
}

// Every distinct tag header the user has used across all their points, so
// the client can suggest reusing "architecture" instead of drifting into
// near-duplicates like "building_architecture" — nothing enforces this, it's
// just what gets shown as suggestions when adding a new tag.
export async function getDistinctTagKeys(userId: string): Promise<string[]> {
  const rows = await getMapPoints(userId);
  const keys = new Set<string>();
  for (const row of rows) {
    try {
      const tags = JSON.parse(row.tags_json) as PointTag[];
      for (const tag of tags) if (tag.key) keys.add(tag.key);
    } catch {
      // Malformed tags_json on some row — skip it rather than fail the whole list.
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

// Lets the assistant answer "show me all my Victorian architecture pins" —
// key match is exact (case-insensitive) since keys are meant to be reused
// consistently; value match is a substring so "Victorian-era" still matches
// a query for "Victorian".
export async function findMapPointsByTag(userId: string, key: string, value?: string): Promise<MapPointRow[]> {
  const rows = await getMapPoints(userId);
  return rows.filter((row) => {
    let tags: PointTag[];
    try {
      tags = JSON.parse(row.tags_json) as PointTag[];
    } catch {
      return false;
    }
    return tags.some(
      (tag) =>
        tag.key.toLowerCase() === key.toLowerCase() &&
        (!value || tag.value.toLowerCase().includes(value.toLowerCase()))
    );
  });
}

// --- JLOSME (in-app OSM editor) working set ---------------------------

export type OsmElementType = "node" | "way" | "relation";
export type OsmEditorAction = "none" | "create" | "modify" | "delete";

export interface OsmNodeGeometry {
  lat: number;
  lon: number;
}
export interface OsmWayGeometry {
  nodeIds: number[];
}
export interface OsmRelationMember {
  type: OsmElementType;
  ref: number;
  role: string;
}
export interface OsmRelationGeometry {
  members: OsmRelationMember[];
}
export type OsmGeometry = OsmNodeGeometry | OsmWayGeometry | OsmRelationGeometry;

export interface OsmEditorElementRow {
  user_id: string;
  el_type: OsmElementType;
  el_id: number;
  version: number | null;
  action: OsmEditorAction;
  tags_json: string;
  geometry_json: string;
  updated_at: string;
}

// One element as it comes back from an Overpass download — same shape the
// upsert below merges into a user's working set.
export interface DownloadedOsmElement {
  type: OsmElementType;
  id: number;
  version: number | null;
  tags: Record<string, string>;
  geometry: OsmGeometry;
}

export async function listOsmEditorElements(userId: string): Promise<OsmEditorElementRow[]> {
  const result = await db.execute({
    sql: "SELECT * FROM osm_editor_elements WHERE user_id = ?",
    args: [userId],
  });
  return result.rows as unknown as OsmEditorElementRow[];
}

export async function listDirtyOsmEditorElements(userId: string): Promise<OsmEditorElementRow[]> {
  const result = await db.execute({
    sql: "SELECT * FROM osm_editor_elements WHERE user_id = ? AND action != 'none'",
    args: [userId],
  });
  return result.rows as unknown as OsmEditorElementRow[];
}

export async function getOsmEditorElement(
  userId: string,
  type: OsmElementType,
  id: number
): Promise<OsmEditorElementRow | null> {
  const result = await db.execute({
    sql: "SELECT * FROM osm_editor_elements WHERE user_id = ? AND el_type = ? AND el_id = ?",
    args: [userId, type, id],
  });
  return (result.rows[0] as unknown as OsmEditorElementRow | undefined) ?? null;
}

// Merges a freshly-downloaded batch into the user's working set: a brand
// new element is inserted as clean (action 'none'); an element already
// present gets refreshed to the newly-downloaded copy ONLY if it's still
// clean — one already being edited (action != 'none') is left completely
// alone rather than clobbering in-progress work. The ON CONFLICT ... DO
// UPDATE ... WHERE clause below does both an insert-if-absent and a
// conditional-refresh-if-present in one statement: when the WHERE fails to
// match (the existing row is dirty), the DO UPDATE becomes a no-op and the
// existing row is left untouched, same as DO NOTHING would.
export async function upsertDownloadedOsmElements(userId: string, elements: DownloadedOsmElement[]): Promise<void> {
  const CHUNK_SIZE = 200;
  for (let i = 0; i < elements.length; i += CHUNK_SIZE) {
    const chunk = elements.slice(i, i + CHUNK_SIZE);
    await db.batch(
      chunk.map((el) => ({
        sql: `INSERT INTO osm_editor_elements (user_id, el_type, el_id, version, action, tags_json, geometry_json)
              VALUES (?, ?, ?, ?, 'none', ?, ?)
              ON CONFLICT(user_id, el_type, el_id) DO UPDATE SET
                version = excluded.version,
                tags_json = excluded.tags_json,
                geometry_json = excluded.geometry_json,
                updated_at = datetime('now')
              WHERE osm_editor_elements.action = 'none'`,
        args: [userId, el.type, el.id, el.version, JSON.stringify(el.tags ?? {}), JSON.stringify(el.geometry)],
      })),
      "write"
    );
  }
}

// Locally-created elements get sequential negative ids, scoped per user and
// per element type (a node and a way can both be "-1" at once) — the same
// scoping OSM itself uses for negative ids within one upload diff.
export async function nextLocalOsmElementId(userId: string, type: OsmElementType): Promise<number> {
  const result = await db.execute({
    sql: "SELECT MIN(el_id) as minId FROM osm_editor_elements WHERE user_id = ? AND el_type = ?",
    args: [userId, type],
  });
  const minId = (result.rows[0] as unknown as { minId: number | null } | undefined)?.minId;
  if (minId == null || minId >= 0) return -1;
  return minId - 1;
}

export async function createLocalOsmElement(
  userId: string,
  type: OsmElementType,
  tags: Record<string, string>,
  geometry: OsmGeometry
): Promise<OsmEditorElementRow> {
  const id = await nextLocalOsmElementId(userId, type);
  await db.execute({
    sql: `INSERT INTO osm_editor_elements (user_id, el_type, el_id, version, action, tags_json, geometry_json)
          VALUES (?, ?, ?, NULL, 'create', ?, ?)`,
    args: [userId, type, id, JSON.stringify(tags ?? {}), JSON.stringify(geometry)],
  });
  return (await getOsmEditorElement(userId, type, id))!;
}

export interface OsmEditorPatch {
  tags?: Record<string, string>;
  geometry?: OsmGeometry;
}

// Covers both a tag edit and a node drag / way node-list edit — a
// not-yet-uploaded local creation stays 'create' (it's still just an unsent
// creation, not a modification of something the server has); a clean or
// previously-pending-delete element becomes 'modify' (editing something
// marked for deletion is treated as changing your mind about the delete).
export async function patchOsmElement(
  userId: string,
  type: OsmElementType,
  id: number,
  patch: OsmEditorPatch
): Promise<OsmEditorElementRow | null> {
  const row = await getOsmEditorElement(userId, type, id);
  if (!row) return null;
  const nextAction: OsmEditorAction = row.action === "create" ? "create" : "modify";
  const nextTags = patch.tags ? JSON.stringify(patch.tags) : row.tags_json;
  const nextGeometry = patch.geometry ? JSON.stringify(patch.geometry) : row.geometry_json;
  await db.execute({
    sql: `UPDATE osm_editor_elements SET tags_json = ?, geometry_json = ?, action = ?, updated_at = datetime('now')
          WHERE user_id = ? AND el_type = ? AND el_id = ?`,
    args: [nextTags, nextGeometry, nextAction, userId, type, id],
  });
  return getOsmEditorElement(userId, type, id);
}

// A never-uploaded local creation just disappears (nothing on the server to
// delete); anything else gets marked 'delete' and stays in the working set
// so the pending delete is what actually gets uploaded.
export async function deleteOsmElement(
  userId: string,
  type: OsmElementType,
  id: number
): Promise<"removed" | "marked" | null> {
  const row = await getOsmEditorElement(userId, type, id);
  if (!row) return null;
  if (row.action === "create") {
    await db.execute({
      sql: "DELETE FROM osm_editor_elements WHERE user_id = ? AND el_type = ? AND el_id = ?",
      args: [userId, type, id],
    });
    return "removed";
  }
  await db.execute({
    sql: "UPDATE osm_editor_elements SET action = 'delete', updated_at = datetime('now') WHERE user_id = ? AND el_type = ? AND el_id = ?",
    args: [userId, type, id],
  });
  return "marked";
}

export async function clearOsmEditorWorkingSet(userId: string): Promise<void> {
  await db.execute({ sql: "DELETE FROM osm_editor_elements WHERE user_id = ?", args: [userId] });
}

export interface OsmDiffMapping {
  type: OsmElementType;
  oldId: number;
  newId: number;
  newVersion: number;
}

// Applies a successful changeset upload's results back onto the working
// set: every row that was part of the uploaded batch gets its id/version
// bumped from the diffResult mapping (a no-op for a plain modify, where
// old id == new id) and its action reset to 'none'; a way/relation in that
// same batch that referenced one of the remapped negative (not-yet-real)
// ids gets that reference rewritten to the new real id first. Confirmed
// deletes are just removed outright. Scoped to `batch` (the dirty rows this
// upload actually sent) rather than the whole working set, since a
// negative id can only ever have come from an element this user created
// locally in the first place.
export async function applyOsmUploadResults(
  userId: string,
  batch: OsmEditorElementRow[],
  mappings: OsmDiffMapping[],
  deleted: { type: OsmElementType; id: number }[]
): Promise<void> {
  const idMap = new Map<string, number>();
  for (const m of mappings) if (m.oldId !== m.newId) idMap.set(`${m.type}:${m.oldId}`, m.newId);
  const mappingByOldId = new Map<string, OsmDiffMapping>();
  for (const m of mappings) mappingByOldId.set(`${m.type}:${m.oldId}`, m);

  for (const row of batch) {
    if (row.action === "delete") continue; // handled via `deleted` below

    let geometryJson = row.geometry_json;
    if (row.el_type === "way") {
      const geom = JSON.parse(row.geometry_json) as OsmWayGeometry;
      geometryJson = JSON.stringify({
        nodeIds: geom.nodeIds.map((nid) => idMap.get(`node:${nid}`) ?? nid),
      } satisfies OsmWayGeometry);
    } else if (row.el_type === "relation") {
      const geom = JSON.parse(row.geometry_json) as OsmRelationGeometry;
      geometryJson = JSON.stringify({
        members: geom.members.map((m) => ({ ...m, ref: idMap.get(`${m.type}:${m.ref}`) ?? m.ref })),
      } satisfies OsmRelationGeometry);
    }

    const mapping = mappingByOldId.get(`${row.el_type}:${row.el_id}`);
    const newId = mapping?.newId ?? row.el_id;
    const newVersion = mapping?.newVersion ?? row.version;
    await db.execute({
      sql: `UPDATE osm_editor_elements SET el_id = ?, version = ?, geometry_json = ?, action = 'none', updated_at = datetime('now')
            WHERE user_id = ? AND el_type = ? AND el_id = ?`,
      args: [newId, newVersion, geometryJson, userId, row.el_type, row.el_id],
    });
  }

  for (const d of deleted) {
    await db.execute({
      sql: "DELETE FROM osm_editor_elements WHERE user_id = ? AND el_type = ? AND el_id = ?",
      args: [userId, d.type, d.id],
    });
  }
}
