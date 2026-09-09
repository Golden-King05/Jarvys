const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// The main overpass-api.de instance is frequently overloaded (503s); the
// community-run kumi.systems mirror has been more reliable in practice.
const OVERPASS_URL = "https://overpass.kumi.systems/api/interpreter";

// Both OpenStreetMap services ask API clients to identify themselves with a
// descriptive User-Agent (see https://operations.osmfoundation.org/policies/nominatim/).
const USER_AGENT = "Jarvys-personal-assistant/1.0 (https://github.com/Golden-King05/Jarvys)";

export interface GeoPoint {
  name: string;
  lat: number;
  lon: number;
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  boundingbox?: [string, string, string, string]; // [south, north, west, east]
}

export async function geocode(place: string): Promise<GeoPoint | { error: string }> {
  const params = new URLSearchParams({ q: place, format: "json", limit: "1" });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    return { error: `Location lookup failed (${res.status})` };
  }
  const data = (await res.json()) as NominatimResult[];
  const top = data[0];
  if (!top) {
    return { error: `Couldn't find a location for "${place}"` };
  }
  return { name: top.display_name, lat: Number(top.lat), lon: Number(top.lon) };
}

export interface BoundingBox {
  south: number;
  north: number;
  west: number;
  east: number;
}

export interface GeoArea extends GeoPoint {
  boundingBox: BoundingBox;
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

// Like geocode, but also returns the area's extent — for a whole region
// (a county, city, park) rather than a single point. Nominatim usually
// returns a real bounding box for a named area; if it doesn't, fall back to
// a small ~5km box around the point so callers always get something to tile.
export async function geocodeArea(place: string): Promise<GeoArea | { error: string }> {
  const params = new URLSearchParams({ q: place, format: "json", limit: "1" });
  const res = await fetch(`${NOMINATIM_URL}?${params}`, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    return { error: `Location lookup failed (${res.status})` };
  }
  const data = (await res.json()) as NominatimResult[];
  const top = data[0];
  if (!top) {
    return { error: `Couldn't find a location for "${place}"` };
  }
  const lat = Number(top.lat);
  const lon = Number(top.lon);
  if (!top.boundingbox) {
    const dLat = 5 / 111;
    const dLon = 5 / (111 * Math.cos(toRad(lat)) || 1);
    return {
      name: top.display_name,
      lat,
      lon,
      boundingBox: { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon },
    };
  }
  const [south, north, west, east] = top.boundingbox.map(Number);
  return { name: top.display_name, lat, lon, boundingBox: { south, north, west, east } };
}

// Straight-line ("as the crow flies") distance — no routing API involved, so
// this won't match driving distance, but needs no API key and answers
// "how far apart are X and Y" immediately.
function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export interface DistanceResult {
  from: GeoPoint;
  to: GeoPoint;
  distanceMiles: number;
  distanceKm: number;
}

export async function calculateDistance(
  fromPlace: string,
  toPlace: string
): Promise<DistanceResult | { error: string }> {
  const [from, to] = await Promise.all([geocode(fromPlace), geocode(toPlace)]);
  if ("error" in from) return from;
  if ("error" in to) return to;
  const miles = haversineMiles(from, to);
  return {
    from,
    to,
    distanceMiles: Math.round(miles * 10) / 10,
    distanceKm: Math.round(miles * 1.60934 * 10) / 10,
  };
}

// Overpass only understands OSM's own amenity tags, not free-text like
// "good restaurants" — map the model's category guess onto the closest one.
function mapCategory(raw: string): string {
  const c = raw.toLowerCase();
  if (/coffee|cafe/.test(c)) return "cafe";
  if (/\bbar\b|pub|brewery/.test(c)) return "bar";
  if (/fast.?food|burger|pizza/.test(c)) return "fast_food";
  return "restaurant";
}

export function categoryIcon(tag: string): string {
  switch (tag) {
    case "cafe":
      return "☕";
    case "bar":
      return "🍺";
    case "fast_food":
      return "🍔";
    default:
      return "🍽️";
  }
}

export interface PlaceResult {
  name: string;
  lat: number;
  lon: number;
  address?: string;
}

export interface FindPlacesResult {
  center: GeoPoint;
  category: string;
  places: PlaceResult[];
}

interface OverpassElement {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

interface OverpassResponse {
  elements: OverpassElement[];
}

// Free, keyless alternative to a paid places API — trades off not having
// ratings or reviews (OSM just tags what exists) for zero setup.
export async function findPlaces(near: string, category: string): Promise<FindPlacesResult | { error: string }> {
  const center = await geocode(near);
  if ("error" in center) return center;

  const tag = mapCategory(category);
  const query = `[out:json][timeout:25];(node["amenity"="${tag}"](around:3000,${center.lat},${center.lon});way["amenity"="${tag}"](around:3000,${center.lat},${center.lon}););out center 8;`;

  const res = await fetch(`${OVERPASS_URL}?${new URLSearchParams({ data: query })}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    return { error: `Place search failed (${res.status})` };
  }

  const data = (await res.json()) as OverpassResponse;
  const places: PlaceResult[] = data.elements.flatMap((el) => {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    const name = el.tags?.name;
    if (lat == null || lon == null || !name) return [];
    const addressParts = [el.tags?.["addr:housenumber"], el.tags?.["addr:street"]].filter(Boolean);
    return [{ name, lat, lon, address: addressParts.length ? addressParts.join(" ") : undefined }];
  });

  if (places.length === 0) {
    return { error: `Couldn't find any ${tag.replace("_", " ")}s near ${near}` };
  }
  return { center, category: tag, places };
}
