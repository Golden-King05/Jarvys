// Downloads full, editable OSM data (every node/way/relation in an area,
// complete tags + version/changeset/user meta, ways/relations resolved down
// to their member nodes) for the JLOSME editor's "draw a boundary, download
// what's inside it" flow. Deliberately a separate module from osm.ts rather
// than an extension of it — osm.ts's findOsmElementsInArea powers the
// read-only "OpenStreetMap" map layer (named elements only, centroid-only
// geometry via `out center tags`, no version/meta) which is a different,
// already-working feature; this one needs every element regardless of
// whether it's named, full node-by-node/member geometry, and full meta, so
// it gets its own query and its own parser rather than bending that one to
// do both jobs. The multi-mirror-fallback-with-timeout boilerplate below is
// intentionally the same shape as osm.ts's (same constants, same style) —
// duplicated on purpose so osm.ts's own tested behavior is never touched.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "JarvysApp/1.0 (personal assistant app; contact: theultimategoldenking@gmail.com)";

// A query timeout a little longer than the Overpass query's own
// [timeout:30] below, so a mirror that's genuinely working (just slow under
// load) gets a chance to return Overpass's own clean timeout error before
// this aborts the connection outright — same reasoning as osm.ts's
// OVERPASS_TIMEOUT_MS.
const OVERPASS_TIMEOUT_MS = 35000;

// An editor download pulls full geometry + meta for every element in the
// area (not just named ones with a centroid), which is a much heavier ask
// per square degree than the map layer's query — kept smaller than that
// layer's own 0.05 bound isn't necessary, but a boundary editor is still
// meant for neighborhood-sized, deliberate edits, not "download a county,"
// so this stays modest as a shared-resource courtesy to Overpass.
const MAX_BBOX_DEGREES = 0.08;
// A hard cap on how many elements one download will keep, purely so a
// pathological area (or a mirror returning more than expected) can't hand
// back an unbounded response — truncation is flagged to the caller rather
// than silently dropped.
const MAX_ELEMENTS = 8000;

export type OsmElementType = "node" | "way" | "relation";

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

export interface DownloadedOsmElement {
  type: OsmElementType;
  id: number;
  version: number | null;
  tags: Record<string, string>;
  geometry: OsmGeometry;
}

export type OsmEditorArea =
  | { kind: "bbox"; south: number; west: number; north: number; east: number }
  | { kind: "polygon"; points: { lat: number; lon: number }[] };

function boundingBoxOf(area: OsmEditorArea): { south: number; west: number; north: number; east: number } {
  if (area.kind === "bbox") return area;
  const lats = area.points.map((p) => p.lat);
  const lons = area.points.map((p) => p.lon);
  return { south: Math.min(...lats), north: Math.max(...lats), west: Math.min(...lons), east: Math.max(...lons) };
}

// Rejects (rather than silently clamping, the way the passive map layer
// does) an area too large to responsibly query — a boundary draw is a
// deliberate one-shot action, so it's better to ask the user to redraw a
// smaller area than to quietly serve incomplete coverage.
export function checkAreaSize(area: OsmEditorArea): { error: string } | { ok: true } {
  const box = boundingBoxOf(area);
  if (box.north - box.south > MAX_BBOX_DEGREES || box.east - box.west > MAX_BBOX_DEGREES) {
    return {
      error: `That area is too large to download at once (max ~${MAX_BBOX_DEGREES}° across) — draw a smaller boundary, then use "expand selection" to add more.`,
    };
  }
  return { ok: true };
}

function buildQuery(area: OsmEditorArea): string {
  const filter =
    area.kind === "bbox"
      ? `${area.south},${area.west},${area.north},${area.east}`
      : `poly:"${area.points.map((p) => `${p.lat} ${p.lon}`).join(" ")}"`;
  return `[out:json][timeout:30];(node(${filter});way(${filter});relation(${filter}););out meta;>;out meta;`;
}

interface OverpassMetaElement {
  type: OsmElementType;
  id: number;
  version?: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: { type: OsmElementType; ref: number; role: string }[];
}

interface OverpassMetaResponse {
  elements: OverpassMetaElement[];
}

function toDownloadedElement(e: OverpassMetaElement): DownloadedOsmElement | null {
  if (e.type === "node") {
    if (e.lat == null || e.lon == null) return null;
    return { type: "node", id: e.id, version: e.version ?? null, tags: e.tags ?? {}, geometry: { lat: e.lat, lon: e.lon } };
  }
  if (e.type === "way") {
    return { type: "way", id: e.id, version: e.version ?? null, tags: e.tags ?? {}, geometry: { nodeIds: e.nodes ?? [] } };
  }
  if (e.type === "relation") {
    return {
      type: "relation",
      id: e.id,
      version: e.version ?? null,
      tags: e.tags ?? {},
      geometry: { members: (e.members ?? []).map((m) => ({ type: m.type, ref: m.ref, role: m.role })) },
    };
  }
  return null;
}

// Fetches every node/way/relation in the given boundary (a plain bbox, or a
// freeform polygon via Overpass's `poly:` filter) with full tags and meta —
// the raw material the editor downloads, merges into the user's working
// set, and lets them edit. Confirmed by hand against overpass.kumi.systems:
// a small area returned 518 nodes/66 ways/4 relations with full
// version/changeset/user/uid/timestamp/tags/nodes/members fields in ~5s.
// Races all mirrors at once rather than trying them one after another —
// sequential fallback meant a slow-but-eventually-working first mirror made
// every download pay its full timeout before even trying the next one
// (worst case, the sum of all three timeouts: ~100s+, which felt like a
// frozen screen and could even outlast the client's own 55s request
// timeout and surface as a hard failure). Racing bounds the wait to
// whichever mirror answers first, so a slow/overloaded one no longer taxes
// requests that a healthy mirror could've served quickly.
async function fetchFromFastestMirror(query: string): Promise<OverpassMetaResponse> {
  const controllers = OVERPASS_URLS.map(() => new AbortController());
  const attempts = OVERPASS_URLS.map((url, i) => {
    const controller = controllers[i];
    const timer = setTimeout(() => controller.abort(), OVERPASS_TIMEOUT_MS);
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${url} (${res.status})`);
        return (await res.json()) as OverpassMetaResponse;
      })
      .catch((err) => {
        throw new Error(`${url}: ${err instanceof Error ? err.message : "network error"}`);
      })
      .finally(() => clearTimeout(timer));
  });

  try {
    return await Promise.any(attempts);
  } catch (aggregate) {
    const messages =
      aggregate instanceof AggregateError
        ? aggregate.errors.map((e) => (e instanceof Error ? e.message : String(e)))
        : [aggregate instanceof Error ? aggregate.message : String(aggregate)];
    throw new Error(messages.join("; "));
  } finally {
    // A winner (or an all-round failure) means every other attempt is now
    // pointless — stop tying up mirrors that other users' requests need.
    for (const controller of controllers) controller.abort();
  }
}

export async function downloadOsmEditorArea(
  area: OsmEditorArea
): Promise<{ elements: DownloadedOsmElement[]; truncated: boolean } | { error: string }> {
  const query = buildQuery(area);

  let data: OverpassMetaResponse;
  try {
    data = await fetchFromFastestMirror(query);
  } catch (err) {
    return { error: `OpenStreetMap download failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // The query's own shape (`out meta; >; out meta;`) legitimately returns
  // every top-level element twice — Overpass's `>` recursion adds to the
  // same result set rather than replacing it, so the first `out` and the
  // (now-larger) second `out` both include it. Deduping by (type, id) here
  // — rather than leaving it to the DB upsert's own ON CONFLICT to quietly
  // collapse them — keeps the count reported back to the user accurate.
  const byKey = new Map<string, DownloadedOsmElement>();
  for (const raw of data.elements) {
    const el = toDownloadedElement(raw);
    if (el) byKey.set(`${el.type}:${el.id}`, el);
  }
  const elements = [...byKey.values()];
  const truncated = elements.length > MAX_ELEMENTS;
  return { elements: elements.slice(0, MAX_ELEMENTS), truncated };
}
