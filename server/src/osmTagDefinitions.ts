// Builds a wiki-backed tag vocabulary for JLOSME's tag editor from OSM's own
// Taginfo service — the same TagDefinition shape this app's own point-tags
// editor already uses (server/src/pointTags.ts), reused here for
// consistency rather than inventing a second shape, even though the data
// source (Taginfo, not a hand-maintained spreadsheet) is completely
// different.
const TAGINFO_BASE = "https://taginfo.openstreetmap.org/api/4";
const USER_AGENT = "JarvysApp/1.0 (personal assistant app; contact: theultimategoldenking@gmail.com)";

// Top N keys by usage, and top N values per key — generous enough to cover
// the tags someone editing ordinary map data will actually reach for,
// without hammering a shared public service on every cold cache fill.
const TOP_KEYS = 150;
const TOP_VALUES_PER_KEY = 15;
// A key with more distinct values than this in the wild isn't a real closed
// vocabulary (e.g. "name" has millions) — it becomes freeText instead of a
// useless giant enum.
const ENUM_MAX_DISTINCT_VALUES = 60;
// How many key/value lookups run at once — Taginfo is a shared community
// resource, not something to hit with 150 concurrent requests.
const CONCURRENCY = 6;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type TagValueKind = "enum" | "format" | "freeText";

export interface TagDefinition {
  key: string;
  kind: TagValueKind;
  values?: string[];
  hint?: string;
}

interface TaginfoKeysResponse {
  data: { key: string; count_all: number; values_all: number; in_wiki: boolean }[];
}
interface TaginfoValuesResponse {
  data: { value: string; count: number; in_wiki: boolean; description?: string }[];
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Taginfo request failed (${res.status}): ${url}`);
  return (await res.json()) as T;
}

async function buildTagDefinitions(): Promise<TagDefinition[]> {
  const keysRes = await fetchJson<TaginfoKeysResponse>(
    `${TAGINFO_BASE}/keys/all?page=1&rp=${TOP_KEYS}&sortname=count_all&sortorder=desc`
  );
  const keys = keysRes.data ?? [];
  const definitions: (TagDefinition | undefined)[] = new Array(keys.length);

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < keys.length) {
      const i = nextIndex++;
      const k = keys[i];
      if (k.values_all > 0 && k.values_all <= ENUM_MAX_DISTINCT_VALUES) {
        try {
          const valuesRes = await fetchJson<TaginfoValuesResponse>(
            `${TAGINFO_BASE}/key/values?key=${encodeURIComponent(k.key)}&page=1&rp=${TOP_VALUES_PER_KEY}&sortname=count&sortorder=desc`
          );
          const values = (valuesRes.data ?? []).map((v) => v.value).filter(Boolean);
          definitions[i] = values.length > 0 ? { key: k.key, kind: "enum", values } : { key: k.key, kind: "freeText" };
        } catch {
          definitions[i] = { key: k.key, kind: "freeText" };
        }
      } else {
        definitions[i] = { key: k.key, kind: "freeText" };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return definitions.filter((d): d is TagDefinition => d !== undefined);
}

let cache: { data: TagDefinition[]; expiresAt: number } | null = null;
let inflight: Promise<TagDefinition[]> | null = null;

// Built lazily on first request (not at server startup — ~150 keys' worth
// of sequential-ish Taginfo calls shouldn't hold up boot) and cached in
// memory for a long TTL, same spirit as lidarTiles.ts's simple in-memory
// tile cache — no new dependency, no persistence needed for data this
// slow-moving.
export async function getOsmTagDefinitions(): Promise<TagDefinition[]> {
  if (cache && cache.expiresAt > Date.now()) return cache.data;
  if (inflight) return inflight;
  inflight = buildTagDefinitions()
    .then((data) => {
      cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
      return data;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
