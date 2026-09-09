const WIKI_SEARCH_URL = "https://en.wikipedia.org/w/api.php";
const WIKI_SUMMARY_URL = "https://en.wikipedia.org/api/rest_v1/page/summary/";

// Wikimedia asks API clients to identify themselves with a descriptive
// User-Agent (see https://meta.wikimedia.org/wiki/User-Agent_policy).
const USER_AGENT = "Jarvys-personal-assistant/1.0 (https://github.com/Golden-King05/Jarvys)";

interface WikiSearchResponse {
  query?: { search?: { title: string }[] };
}

interface WikiSummaryResponse {
  title: string;
  extract: string;
  content_urls?: { desktop?: { page?: string } };
  coordinates?: { lat: number; lon: number };
}

export interface WikipediaResult {
  title: string;
  summary: string;
  url: string;
  // Only set for geotagged articles (places, landmarks) — lets a factual
  // lookup like "the oldest building still standing in NYC" drop a real pin
  // instead of just answering in text.
  coordinates?: { lat: number; lon: number };
}

async function fetchSummary(title: string): Promise<WikipediaResult | { error: string }> {
  const summaryRes = await fetch(`${WIKI_SUMMARY_URL}${encodeURIComponent(title)}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!summaryRes.ok) {
    return { error: `Could not load the Wikipedia summary for "${title}" (${summaryRes.status})` };
  }
  const summaryData = (await summaryRes.json()) as WikiSummaryResponse;

  return {
    title: summaryData.title,
    summary: summaryData.extract,
    url:
      summaryData.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    ...(summaryData.coordinates ? { coordinates: summaryData.coordinates } : {}),
  };
}

export async function searchWikipedia(query: string): Promise<WikipediaResult | { error: string }> {
  const searchParams = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1",
    format: "json",
  });

  const searchRes = await fetch(`${WIKI_SEARCH_URL}?${searchParams}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!searchRes.ok) {
    return { error: `Wikipedia search failed (${searchRes.status})` };
  }
  const searchData = (await searchRes.json()) as WikiSearchResponse;
  const topTitle = searchData.query?.search?.[0]?.title;
  if (!topTitle) {
    return { error: `No Wikipedia article found for "${query}"` };
  }

  return fetchSummary(topTitle);
}

// For URL imports — pulls the article title straight out of a
// wikipedia.org/wiki/<title> URL rather than re-searching for it.
export function wikipediaTitleFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)wikipedia\.org$/.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/wiki\/(.+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export async function getWikipediaByTitle(title: string): Promise<WikipediaResult | { error: string }> {
  return fetchSummary(title);
}

export interface BoundingBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface NearbyArticle {
  pageid: number;
  title: string;
  extract: string;
  lat: number;
  lon: number;
  url: string;
}

interface GeoSearchPage {
  pageid: number;
  title: string;
  extract?: string;
  coordinates?: { lat: number; lon: number }[];
}

interface GeoSearchResponse {
  query?: { pages?: Record<string, GeoSearchPage> };
}

// Wikipedia's geosearch caps the radius at 10km — a single call can't cover
// anything bigger than that around one point.
const WIKI_GEOSEARCH_MAX_RADIUS_METERS = 10000;

async function findArticlesNear(lat: number, lon: number, limit: number): Promise<NearbyArticle[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "geosearch",
    ggscoord: `${lat}|${lon}`,
    ggsradius: String(WIKI_GEOSEARCH_MAX_RADIUS_METERS),
    ggslimit: String(limit),
    prop: "extracts|coordinates",
    exintro: "1",
    explaintext: "1",
    exchars: "300",
    format: "json",
  });
  const res = await fetch(`${WIKI_SEARCH_URL}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return [];
  const data = (await res.json()) as GeoSearchResponse;
  const pages = data.query?.pages ? Object.values(data.query.pages) : [];
  return pages.flatMap((p) => {
    const coord = p.coordinates?.[0];
    if (!coord) return [];
    return [
      {
        pageid: p.pageid,
        title: p.title,
        extract: p.extract ?? "",
        lat: coord.lat,
        lon: coord.lon,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`,
      },
    ];
  });
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// Caps how many geosearch calls one request makes — a whole US state would
// otherwise mean hundreds of tiled queries.
const MAX_GRID_TILES = 12;
const TILE_STEP_KM = (WIKI_GEOSEARCH_MAX_RADIUS_METERS / 1000) * 1.3;

// Covers an area bigger than one geosearch call's 10km reach by tiling
// several searches across a grid and merging the results. Large areas get
// a coarser grid instead of failing outright — areaTooLarge tells the
// caller coverage may have gaps so it can say so.
export async function findArticlesInArea(
  box: BoundingBox,
  maxResults: number
): Promise<{ articles: NearbyArticle[]; areaTooLarge: boolean }> {
  const heightKm = haversineKm(box.south, box.west, box.north, box.west);
  const widthKm = haversineKm(box.south, box.west, box.south, box.east);

  let rows = Math.max(1, Math.round(heightKm / TILE_STEP_KM));
  let cols = Math.max(1, Math.round(widthKm / TILE_STEP_KM));
  const idealTiles = rows * cols;
  while (rows * cols > MAX_GRID_TILES) {
    if (rows >= cols) rows--;
    else cols--;
  }

  const latStep = (box.north - box.south) / rows;
  const lonStep = (box.east - box.west) / cols;
  const centers: { lat: number; lon: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      centers.push({ lat: box.south + latStep * (r + 0.5), lon: box.west + lonStep * (c + 0.5) });
    }
  }

  const perTileLimit = Math.min(50, Math.max(10, maxResults));
  const results = await Promise.all(centers.map((p) => findArticlesNear(p.lat, p.lon, perTileLimit)));

  const merged = new Map<number, NearbyArticle>();
  for (const articles of results) {
    for (const article of articles) merged.set(article.pageid, article);
  }

  return { articles: [...merged.values()].slice(0, maxResults), areaTooLarge: idealTiles > MAX_GRID_TILES };
}
