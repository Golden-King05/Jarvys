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
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, dedupe_key)
  );

  CREATE INDEX IF NOT EXISTS idx_map_points_user ON map_points(user_id);
`);

// chat_messages predates map_data_json/tools_used_json — add them for
// databases created before these columns existed. SQLite has no "ADD COLUMN
// IF NOT EXISTS", so ignore the one error that means it's already there.
for (const column of ["map_data_json", "tools_used_json"]) {
  try {
    await db.execute(`ALTER TABLE chat_messages ADD COLUMN ${column} TEXT`);
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
  }
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
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  map_data_json: string | null;
  tools_used_json: string | null;
  created_at: string;
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

// A user-initiated add (manual pin or URL import) — overwrites an existing
// point at the same dedupe key, since re-adding the same spot on purpose
// means the user wants today's details to win.
export async function createMapPoint(userId: string, point: NewMapPoint): Promise<MapPointRow> {
  const id = randomUUID();
  const dedupeKey = dedupeKeyFor(point.name, point.lat, point.lon);
  await db.execute({
    sql: `INSERT INTO map_points (id, user_id, name, category, subcategory, icon, lat, lon, urls_json, blurb, source, dedupe_key)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, dedupe_key) DO UPDATE SET
            name = excluded.name, category = excluded.category, subcategory = excluded.subcategory,
            icon = excluded.icon, urls_json = excluded.urls_json, blurb = excluded.blurb, source = excluded.source`,
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
      sql: `INSERT INTO map_points (id, user_id, name, category, subcategory, icon, lat, lon, urls_json, blurb, source, dedupe_key)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  };

  await db.execute({
    sql: `UPDATE map_points
          SET name = ?, category = ?, subcategory = ?, icon = ?, lat = ?, lon = ?, urls_json = ?, blurb = ?, dedupe_key = ?
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
      dedupeKeyFor(next.name, next.lat, next.lon),
      id,
      userId,
    ],
  });

  const updated = await db.execute({ sql: "SELECT * FROM map_points WHERE id = ?", args: [id] });
  return updated.rows[0] as unknown as MapPointRow;
}
