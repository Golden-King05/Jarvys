// Overpass (OpenStreetMap's query API) — free, keyless, but a shared public
// resource, so queries stay tightly bounded (a small viewport, a result cap)
// rather than pulling everything Overpass would happily hand back.
//
// The canonical overpass-api.de endpoint (and its lz4 load-balancer alias)
// reliably resets the connection from this server's own network — the same
// "blocked from a cloud host's IP range" problem flights.ts already works
// around for OpenSky, confirmed by hand against several instances. These
// community-run mirrors serve the identical API and answer normally, so
// they're tried in order as a fallback rather than failing the layer outright.
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "JarvysApp/1.0 (personal assistant app; contact: theultimategoldenking@gmail.com)";

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export type OsmElementType = "node" | "way" | "relation";

export interface OsmElement {
  osmType: OsmElementType;
  osmId: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

interface OverpassElement {
  type: OsmElementType;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// Keeps one query from covering an unreasonably large area — Overpass is a
// shared community resource, and beyond a neighborhood-sized bbox, resolving
// full way/relation geometry (needed for the `center` output below) can get
// slow fast, confirmed by hand: the same tiny few-block area answered in
// 2-3s on one try and took 14s+ for ways alone on another, purely from
// mirror load. Above this size the query still runs (clamped to this span)
// but areaTooLarge tells the caller coverage isn't complete, the same
// pattern as the Wikipedia layer.
const MAX_BBOX_DEGREES = 0.05;
const MAX_RESULTS = 300;
// Per-mirror budget — kept well under the client's own 55s request timeout
// even with all three OVERPASS_URLS tried in sequence (3 * 12s = 36s worst
// case), since a mirror that hasn't answered by then is more useful to move
// on from than to keep waiting on. A bit longer than the query's own
// [timeout:10] below so a mirror that is genuinely working, just slow, gets
// a chance to return Overpass's own clean timeout error before this aborts
// the connection outright.
const OVERPASS_TIMEOUT_MS = 12000;

// The same allowlist as the client's OSM_CATEGORY_OPTIONS (app/src/utils/
// osm.ts) — kept as its own copy here since this side's job is different
// (a strict allowlist for building a raw Overpass query string, not display
// labels) but the two must name the same OSM keys or a category selected in
// the UI would silently do nothing.
export const OSM_CATEGORY_KEYS = [
  "amenity",
  "shop",
  "tourism",
  "historic",
  "leisure",
  "natural",
  "craft",
  "office",
  "man_made",
  "railway",
  "waterway",
  "building",
  "highway",
] as const;

// Fetches named node/way/relation in the given area — the raw material for
// the map's "OpenStreetMap" layer. Ways and relations come back with
// Overpass's own computed centroid (the `center` output mode) rather than
// their full geometry, which is all a single map pin needs. `categories`
// (validated against OSM_CATEGORY_KEYS by the route) narrows the query to
// elements carrying at least one of those tag keys — querying literally
// every named element regardless of tags was the previous behavior and is
// what was timing out on a busy viewport.
export async function findOsmElementsInArea(
  box: BoundingBox,
  limit = MAX_RESULTS,
  categories?: string[]
): Promise<{ elements: OsmElement[]; areaTooLarge: boolean } | { error: string }> {
  const south = Math.max(box.south, box.north - MAX_BBOX_DEGREES);
  const west = Math.max(box.west, box.east - MAX_BBOX_DEGREES);
  const areaTooLarge = box.north - box.south > MAX_BBOX_DEGREES || box.east - box.west > MAX_BBOX_DEGREES;

  const bbox = `${south},${west},${box.north},${box.east}`;
  const keyFilters = categories && categories.length > 0 ? categories.map((k) => `["${k}"]`) : [""];
  const clauses = keyFilters
    .flatMap((filter) => [`node["name"]${filter}(${bbox});`, `way["name"]${filter}(${bbox});`, `relation["name"]${filter}(${bbox});`])
    .join("");
  const query = `[out:json][timeout:10];(${clauses});out center tags;`;

  let data: OverpassResponse | null = null;
  const errors: string[] = [];
  for (const url of OVERPASS_URLS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
      });
      if (!res.ok) {
        errors.push(`${url} (${res.status})`);
        continue;
      }
      data = (await res.json()) as OverpassResponse;
      break;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : "network error"}`);
    }
  }
  if (!data) {
    return { error: `OpenStreetMap lookup failed: ${errors.join("; ")}` };
  }

  const elements: OsmElement[] = data.elements.flatMap((e) => {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat == null || lon == null || !e.tags || !e.tags.name) return [];
    return [{ osmType: e.type, osmId: e.id, lat, lon, tags: e.tags }];
  });

  return { elements: elements.slice(0, limit), areaTooLarge };
}
