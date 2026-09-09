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
  kind: "places" | "distance" | "landmark" | "regions" | "point_suggestion";
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
  layer: "radar" | "timezones" | "pins";
  enabled: boolean;
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
}

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  mapData: MapData | null;
  toolsUsed: string[];
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
  category?: string;
  subcategory?: string;
  icon?: string;
}

export type ImportPointResult = { needsLocation: true; name: string } | { needsLocation: false; point: Point };

async function request<T>(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
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
