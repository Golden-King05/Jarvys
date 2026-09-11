export class ApiError extends Error {}

export interface AssistantSettings {
  assistantName: string;
  instructions: string;
  preferences: Record<string, unknown>;
  preferredProvider: Provider;
  updatedAt: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  contextWindow: number;
}

export interface DailyRateLimit {
  limitRequests: number;
  remainingRequests: number;
}

export interface ThinkingRequest {
  reason: string;
}

export type Provider = "groq" | "gemini";

// A structured label on a point — a header (e.g. "architecture") and a value
// (e.g. "Victorian"), so the same header naturally accumulates consistent
// values across points instead of drifting into near-duplicate headers.
export interface PointTag {
  key: string;
  value: string;
}

export type TagValueKind = "enum" | "format" | "freeText";

// The app's own documented tag vocabulary (start_date, building,
// brand_historic_location, ...) — powers the tag editor's autofill. "enum"
// is a closed set to pick from (values); "format"/"freeText" are free-typed
// with a hint shown as a placeholder.
export interface TagDefinition {
  key: string;
  kind: TagValueKind;
  values?: string[];
  hint?: string;
}

export interface MapPoint {
  // Only present when this point mirrors a saved Point (from the /points
  // list) — lets the map know it's editable/draggable, since an ephemeral
  // result (e.g. a distance endpoint) has nowhere to persist a drag to.
  id?: string;
  label: string;
  lat: number;
  lon: number;
  address?: string;
  icon?: string;
  category?: string;
  subcategory?: string;
  urls?: string[];
  blurb?: string;
  tags?: PointTag[];
}

export type RegionType = "us_state" | "country";
export type RegionStatus = "green" | "yellow" | "red";

export interface RegionMapData {
  name: string;
  geometry: { type: string; coordinates: unknown };
  status?: RegionStatus;
}

export interface MapData {
  kind: "places" | "distance" | "landmark" | "regions" | "point_suggestion" | "flights";
  points: MapPoint[];
  distanceMiles?: number;
  distanceKm?: number;
  regionType?: RegionType;
  regions?: RegionMapData[];
  verified?: boolean;
}

// A request to turn a map layer on or off — the assistant can ask for this,
// but the layer state itself lives entirely on the client.
export interface LayerCommand {
  layer: "radar" | "timezones" | "pins" | "flights" | "wikipedia";
  enabled: boolean;
}

export interface MapBoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface GeocodeResult {
  name: string;
  lat: number;
  lon: number;
}

export type OsmElementType = "node" | "way" | "relation";

// A single tagged OpenStreetMap element — a node, way, or relation with at
// least a name — as returned by the map's "OpenStreetMap" layer query.
export interface OsmElement {
  osmType: OsmElementType;
  osmId: number;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface WikipediaArticle {
  pageid: number;
  title: string;
  extract: string;
  url: string;
}

// Several geotagged articles sitting close enough together to render as one
// pin — the client cycles through `articles` on tap rather than stacking a
// marker per article.
export interface WikipediaCluster {
  lat: number;
  lon: number;
  articles: WikipediaArticle[];
}

export interface ChatResponse {
  reply: string | null;
  usage: ChatUsage | null;
  compressed: boolean;
  droppedMessages: number;
  rateLimit: DailyRateLimit | null;
  thinkingRequest: ThinkingRequest | null;
  provider: Provider | null;
  providerNote: string | null;
  mapData: MapData | null;
  layerCommand: LayerCommand | null;
  toolsUsed: string[];
  // Tools that were called but came back empty-handed this turn — an
  // upstream API erroring, or a map lookup (find_saved_point/
  // find_points_by_tag) that found nothing. A tool name can appear in both
  // this and toolsUsed if it was called more than once with different
  // outcomes.
  toolsFailed: string[];
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  mapData: MapData | null;
  toolsUsed: string[];
  toolsFailed: string[];
}

// A saved pin — user-placed, imported from a URL, or auto-backed-up from
// something the assistant found.
export interface Point {
  id: string;
  name: string;
  category: string;
  subcategory: string;
  icon: string;
  lat: number;
  lon: number;
  urls: string[];
  blurb: string;
  source: string;
  tags: PointTag[];
  createdAt: string;
}

// A saved Point and an in-flight MapPoint from a fresh search share some
// field names (icon, category...) but a MapPoint's `id` is optional and
// present only when it mirrors a saved Point, so "id" in p alone doesn't
// reliably discriminate the union — createdAt only ever exists on Point.
export function isSavedPoint(p: Point | MapPoint): p is Point {
  return "createdAt" in p;
}

export interface NewPoint {
  name: string;
  category?: string;
  subcategory?: string;
  icon?: string;
  lat: number;
  lon: number;
  urls?: string[];
  blurb?: string;
  tags?: PointTag[];
}

export interface ImportPointFromUrl {
  url: string;
  lat?: number;
  lon?: number;
  name?: string;
  category?: string;
  subcategory?: string;
  icon?: string;
  tags?: PointTag[];
}

export type ImportPointResult = { needsLocation: true; name: string } | { needsLocation: false; point: Point };

// Render's free tier spins the server down when idle and takes up to ~50s
// to cold-start the next request — comfortably longer than a browser's own
// default network timeout, which surfaces as an opaque "Load failed" with
// no indication of what actually happened. An explicit timeout here lets us
// show a clear, actionable message instead for that case, and for a plain
// network drop (fetch throws a TypeError with no HTTP response at all).
const REQUEST_TIMEOUT_MS = 55000;

async function request<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError("The server is taking a while to respond (it may be waking up) — please try again.");
    }
    throw new ApiError("Couldn't reach the server — check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  // Used only to "wake" Render's free-tier server (spun down after
  // inactivity, ~50s+ to cold-start) before the user's first real message —
  // a plain fetch with a generous timeout, resolving to a boolean rather
  // than throwing, since a slow health check isn't itself a user-facing
  // error the way a failed chat request is.
  checkHealth: async (baseUrl: string): Promise<boolean> => {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(60000) });
      return res.ok;
    } catch {
      return false;
    }
  },

  register: (baseUrl: string, email: string, password: string) =>
    request<{ token: string; user: { id: string; email: string } }>(baseUrl, "/auth/register", {
      method: "POST",
      body: { email, password },
    }),

  login: (baseUrl: string, email: string, password: string) =>
    request<{ token: string; user: { id: string; email: string } }>(baseUrl, "/auth/login", {
      method: "POST",
      body: { email, password },
    }),

  changePassword: (baseUrl: string, token: string, currentPassword: string, newPassword: string) =>
    request<{ ok: boolean }>(baseUrl, "/auth/password", {
      method: "PUT",
      token,
      body: { currentPassword, newPassword },
    }),

  getSettings: (baseUrl: string, token: string) =>
    request<AssistantSettings>(baseUrl, "/assistant/settings", { token }),

  updateSettings: (baseUrl: string, token: string, patch: Partial<AssistantSettings>) =>
    request<AssistantSettings>(baseUrl, "/assistant/settings", {
      method: "PUT",
      token,
      body: patch,
    }),

  chat: (baseUrl: string, token: string, message: string, forceReasoningEffort?: "default" | "none") =>
    request<ChatResponse>(baseUrl, "/assistant/chat", {
      method: "POST",
      token,
      body: { message, forceReasoningEffort },
    }),

  getMessages: (baseUrl: string, token: string) =>
    request<{ messages: StoredMessage[] }>(baseUrl, "/assistant/messages", { token }),

  transcribe: (baseUrl: string, token: string, audioBase64: string, mimeType: string) =>
    request<{ text: string }>(baseUrl, "/assistant/transcribe", {
      method: "POST",
      token,
      body: { audioBase64, mimeType },
    }),

  getPoints: (baseUrl: string, token: string) => request<{ points: Point[] }>(baseUrl, "/points", { token }),

  // Every tag header already in use across the account's points — powers the
  // "pick an existing header" suggestions in the tag editor so headers
  // naturally stay consistent instead of drifting into near-duplicates.
  getTagKeys: (baseUrl: string, token: string) => request<{ keys: string[] }>(baseUrl, "/points/tags", { token }),

  // The app's own documented tag vocabulary — powers the tag editor's
  // autofill (a known header offers its real values or a format hint
  // instead of a blank free-text box).
  getTagDefinitions: (baseUrl: string, token: string) =>
    request<{ definitions: TagDefinition[] }>(baseUrl, "/points/tag-definitions", { token }),

  // Live aircraft within a map viewport, pre-formatted as ready-to-render
  // points — backs the "Live flights" layer.
  getFlights: (baseUrl: string, token: string, box: MapBoundingBox) =>
    request<{ points: MapPoint[] }>(
      baseUrl,
      `/flights?south=${box.south}&west=${box.west}&north=${box.north}&east=${box.east}`,
      { token }
    ),

  // Nearby geotagged Wikipedia articles, pre-clustered by proximity — backs
  // the "Wikipedia" layer.
  getNearbyWikipedia: (baseUrl: string, token: string, box: MapBoundingBox, limit = 60) =>
    request<{ clusters: WikipediaCluster[]; areaTooLarge: boolean }>(
      baseUrl,
      `/wikipedia/nearby?south=${box.south}&west=${box.west}&north=${box.north}&east=${box.east}&limit=${limit}`,
      { token }
    ),

  // A direct "find this place" lookup — backs the map's search bar.
  geocode: (baseUrl: string, token: string, query: string) =>
    request<GeocodeResult>(baseUrl, `/geocode?q=${encodeURIComponent(query)}`, { token }),

  // Every named OSM node/way/relation in a viewport — backs the map's
  // "OpenStreetMap" layer. Called on demand (its "Query" button), not
  // polled, since browsing raw OSM data is a deliberate action rather than
  // something that should keep re-fetching as the map moves. `categories`
  // (from OSM_CATEGORY_OPTIONS, the layer's own settings gear) narrows the
  // query to just those OSM keys instead of every named element, which is
  // what was timing out on a busy viewport — omit it for the old
  // unrestricted behavior.
  getNearbyOsm: (baseUrl: string, token: string, box: MapBoundingBox, categories?: string[], limit = 200) =>
    request<{ elements: OsmElement[]; areaTooLarge: boolean }>(
      baseUrl,
      `/osm/nearby?south=${box.south}&west=${box.west}&north=${box.north}&east=${box.east}&limit=${limit}` +
        (categories && categories.length > 0 ? `&categories=${categories.join(",")}` : ""),
      { token }
    ),

  createPoint: (baseUrl: string, token: string, point: NewPoint) =>
    request<Point>(baseUrl, "/points", { method: "POST", token, body: point }),

  createPointFromUrl: async (
    baseUrl: string,
    token: string,
    body: ImportPointFromUrl
  ): Promise<ImportPointResult> => {
    const res = await fetch(`${baseUrl}/points/from-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 422 && data.needsLocation) {
      return { needsLocation: true, name: data.name as string };
    }
    if (!res.ok) {
      throw new ApiError(data.error ?? `Request failed (${res.status})`);
    }
    return { needsLocation: false, point: data as Point };
  },

  updatePoint: (baseUrl: string, token: string, id: string, patch: Partial<NewPoint>) =>
    request<Point>(baseUrl, `/points/${id}`, { method: "PUT", token, body: patch }),

  deletePoint: (baseUrl: string, token: string, id: string) =>
    request<{ ok: boolean }>(baseUrl, `/points/${id}`, { method: "DELETE", token }),
};
