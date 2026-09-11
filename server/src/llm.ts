import { getAirQuality } from "./airquality.js";
import { convertCurrency } from "./currency.js";
import { findMapPointsByName, findMapPointsByTag, getDistinctTagKeys, type PointTag } from "./db.js";
import { flightToMapPoint, getFlightsInBoundingBox } from "./flights.js";
import { calculateDistance, categoryIcon, findPlaces, geocode, geocodeArea } from "./geo.js";
import { getGeminiReply, verifyRegionStatuses } from "./gemini.js";
import { getActiveAlerts, getNwsForecast } from "./nws.js";
import { getPointTagReference } from "./pointTags.js";
import { extractRegionsFromText, findRegions, type RegionType } from "./regions.js";
import { getConditions, getForecast } from "./weather.js";
import { searchWeb } from "./websearch.js";
import { findArticlesInArea, getWikipediaByTitle, searchWikipedia, wikipediaTitleFromUrl } from "./wikipedia.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// openai/gpt-oss-120b was the earlier default but has a documented issue
// where it hallucinates calls to tools that don't exist (its "Harmony"
// training format leaking through on non-Harmony-native harnesses) instead
// of reliably calling the tools we actually define — confirmed against our
// own search_wikipedia tool. Qwen uses standard tool-call formatting and is
// one of Groq's own suggested alternatives.
const GROQ_MODEL = process.env.GROQ_MODEL ?? "qwen/qwen3.6-27b";

// Context window for the model above (Groq docs: console.groq.com/docs/models).
// Override with GROQ_CONTEXT_WINDOW if you change GROQ_MODEL to something else.
const CONTEXT_WINDOW_TOKENS = Number(process.env.GROQ_CONTEXT_WINDOW ?? 131072);

// Once the conversation we're about to send is estimated past this fraction of
// the context window, we drop the oldest turns before sending — a simple
// sliding-window "compression" so a long chat never hits a hard API error.
const COMPRESSION_THRESHOLD_RATIO = 0.75;

// Safety cap on tool-call round trips for a single user message.
const MAX_TOOL_ITERATIONS = 4;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
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

export interface MapPointTag {
  key: string;
  value: string;
}

export interface MapPoint {
  label: string;
  lat: number;
  lon: number;
  address?: string;
  icon?: string;
  category?: string;
  subcategory?: string;
  urls?: string[];
  blurb?: string;
  tags?: MapPointTag[];
}

export interface RegionMapData {
  name: string;
  geometry: { type: string; coordinates: unknown };
  // Only set for a legal/categorical-status answer (e.g. "which states
  // allow X") — green/allowed, yellow/permit or restricted, red/not
  // allowed or not mentioned. Left undefined for a plain "show me these
  // regions" answer, which the client renders in one neutral color.
  status?: "green" | "yellow" | "red";
}

// Structured geo data from the map tools, for the Map screen to plot —
// separate from the natural-language reply describing it.
export interface MapData {
  kind: "places" | "distance" | "landmark" | "regions" | "point_suggestion" | "flights";
  points: MapPoint[];
  distanceMiles?: number;
  distanceKm?: number;
  regionType?: RegionType;
  regions?: RegionMapData[];
  // Set when verify_map produced this map — every region was individually
  // classified rather than only the ones the reply's prose happened to
  // mention, so the client can badge it as the more trustworthy version.
  verified?: boolean;
}

// A request to turn a map layer on or off — pure UI state the client owns,
// so the assistant can't set it directly; this just tells the client what
// the user asked for.
export interface LayerCommand {
  layer: "radar" | "timezones" | "pins" | "flights" | "wikipedia";
  enabled: boolean;
}

export interface ChatResult {
  reply: string | null;
  usage: ChatUsage | null;
  compressed: boolean;
  droppedMessages: number;
  rateLimit: DailyRateLimit | null;
  thinkingRequest: ThinkingRequest | null;
  // null only when there's no real answer yet (a thinkingRequest, or the
  // no-GROQ_API_KEY stub) — otherwise which provider actually produced the
  // reply, so the client can show a "switched to Gemini" notice when it
  // differs from the previous turn's provider.
  provider: Provider | null;
  // Set only when the switch was automatic (Groq's limit hit mid-conversation)
  // rather than something the user asked for (approving deep thinking) — the
  // client already knows why in that case, this covers the case it doesn't.
  providerNote: string | null;
  mapData: MapData | null;
  // Set when the assistant called set_map_layer this turn — the client
  // applies it to its own layer-visibility state.
  layerCommand: LayerCommand | null;
  // Names of every tool actually called while producing this reply (e.g.
  // "search_wikipedia", "get_weather") — lets the client show a collapsed
  // "API used" marker instead of having the model narrate its own sourcing
  // in the reply text.
  toolsUsed: string[];
  // Names of tools that were called but came back empty-handed — an
  // upstream API erroring, or (for find_saved_point/find_points_by_tag,
  // which never themselves error) a map lookup that found nothing. Shown
  // alongside toolsUsed rather than folded into it so the client can mark
  // a source as attempted-and-failed instead of implying it contributed.
  // The same tool name can appear in both arrays if the model called it
  // more than once this turn with different outcomes.
  toolsFailed: string[];
}

class GroqRateLimitError extends Error {
  retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function readRetryAfter(res: Response): number | null {
  const header = res.headers.get("retry-after");
  const seconds = header ? Number(header) : NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type GroqMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; name: string; content: string };

interface GroqChatResponse {
  choices: { message: { content: string | null; tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

const SEARCH_WIKIPEDIA_TOOL = {
  type: "function",
  function: {
    name: "search_wikipedia",
    description:
      "Search Wikipedia and return a short summary of the most relevant article. Use this for factual questions about topics, people, places, events, or concepts you should look up rather than guess at.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for on Wikipedia." },
      },
      required: ["query"],
    },
  },
};

const SEARCH_WEB_TOOL = {
  type: "function",
  function: {
    name: "search_web",
    description:
      "Search the general web and return a short list of titles, URLs, and snippets. Use this for information Wikipedia wouldn't have — a local business, current news, product details, prices, hours, or a real place too small or obscure for its own Wikipedia article. Try search_wikipedia first for a well-known person, place, or topic.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
      },
      required: ["query"],
    },
  },
};

const FIND_PLACES_TOOL = {
  type: "function",
  function: {
    name: "find_places",
    description:
      "Find restaurants, cafes, bars, or fast food places near a location and plot them on the user's map. Use this when the user asks to find or recommend places to eat or drink somewhere.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to search near, e.g. a city or address." },
        category: {
          type: "string",
          description: "What kind of place, e.g. restaurant, cafe, bar, fast food. Defaults to restaurant.",
        },
      },
      required: ["location"],
    },
  },
};

const CALCULATE_DISTANCE_TOOL = {
  type: "function",
  function: {
    name: "calculate_distance",
    description:
      "Calculate the straight-line distance between two locations and plot both on the user's map. Use this when the user asks how far apart two places are.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "The first location." },
        to: { type: "string", description: "The second location." },
      },
      required: ["from", "to"],
    },
  },
};

const HIGHLIGHT_REGIONS_TOOL = {
  type: "function",
  function: {
    name: "highlight_regions",
    description:
      "Shade a set of US states or countries on the user's map. You decide which regions match the question yourself (e.g. every US state where something is legal) — this tool only draws the ones you list, so pass every matching region's full common name, not an abbreviation. Use it whenever an answer is naturally a set of states or countries rather than a single place.",
    parameters: {
      type: "object",
      properties: {
        regionType: { type: "string", enum: ["us_state", "country"], description: "What kind of regions these are." },
        names: {
          type: "array",
          items: { type: "string" },
          description: "Full names of every matching region, e.g. [\"Ohio\", \"Michigan\"].",
        },
      },
      required: ["regionType", "names"],
    },
  },
};

const VERIFY_MAP_TOOL = {
  type: "function",
  function: {
    name: "verify_map",
    description:
      "Go through every US state or country one at a time and double-check its status on a topic already discussed, instead of relying on a quick first-pass answer. Call this when the user asks to verify, double-check, reload, or fill in the map more exactly or completely. Infer the topic and regionType from the conversation so far.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The specific topic being checked, e.g. 'owning a raccoon as a pet'." },
        regionType: { type: "string", enum: ["us_state", "country"], description: "Which kind of regions to check." },
      },
      required: ["topic", "regionType"],
    },
  },
};

const GET_WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get current weather conditions for a location. Also drops a pin on the user's map.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to check, e.g. a city or address." },
      },
      required: ["location"],
    },
  },
};

const GET_WEATHER_FORECAST_TOOL = {
  type: "function",
  function: {
    name: "get_weather_forecast",
    description:
      "Get the multi-day weather forecast for a location (highs, lows, condition, chance of precipitation per day) — use this for tomorrow's weather, this week's forecast, or any future day, as opposed to get_weather which is current conditions only. Also drops a pin on the user's map.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to check, e.g. a city or address." },
        days: { type: "number", description: "How many days to forecast, including today (default 5, max 16)." },
      },
      required: ["location"],
    },
  },
};

const GET_WEATHER_ALERTS_TOOL = {
  type: "function",
  function: {
    name: "get_weather_alerts",
    description:
      "Check active severe weather alerts (warnings, watches, advisories) for a US location, via the National Weather Service. US only — if asked about another country, say alerts aren't available there. Use when the user asks about storm warnings, weather alerts, or whether severe weather is expected.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to check, e.g. a city or address." },
      },
      required: ["location"],
    },
  },
};

const GET_AIR_QUALITY_TOOL = {
  type: "function",
  function: {
    name: "get_air_quality",
    description:
      "Get current air quality (US AQI, PM2.5, PM10, ozone) for a location. Use when the user asks about air quality, pollution, smoke, or whether it's safe to be outside. Also drops a pin on the user's map.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to check, e.g. a city or address." },
      },
      required: ["location"],
    },
  },
};

const FIND_FLIGHTS_NEAR_TOOL = {
  type: "function",
  function: {
    name: "find_flights_near",
    description:
      "Find live aircraft currently flying near a location (via OpenSky Network) and preview them on the user's map. Use when the user asks what flights are overhead, near them, or near some place. This is a single snapshot — real positions update roughly every 10-15 seconds.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to search near, e.g. a city or address." },
        radiusKm: { type: "number", description: "Search radius in kilometers (default 50, max 200)." },
      },
      required: ["location"],
    },
  },
};

const SET_MAP_LAYER_TOOL = {
  type: "function",
  function: {
    name: "set_map_layer",
    description:
      "Turn one of the user's map layers on or off: 'radar' (live weather radar overlay), 'timezones' (time zone bands), 'pins' (their saved points), 'flights' (live nearby aircraft), or 'wikipedia' (nearby Wikipedia articles). Use this when the user asks to show, hide, turn on/off, or toggle one of these on the map.",
    parameters: {
      type: "object",
      properties: {
        layer: {
          type: "string",
          enum: ["radar", "timezones", "pins", "flights", "wikipedia"],
          description: "Which layer to change.",
        },
        enabled: { type: "boolean", description: "true to turn it on, false to turn it off." },
      },
      required: ["layer", "enabled"],
    },
  },
};

const GET_LOCAL_TIME_TOOL = {
  type: "function",
  function: {
    name: "get_local_time",
    description: "Get the current local time and timezone for a location. Also drops a pin on the user's map.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The place to check, e.g. a city or address." },
      },
      required: ["location"],
    },
  },
};

const CONVERT_CURRENCY_TOOL = {
  type: "function",
  function: {
    name: "convert_currency",
    description: "Convert an amount from one currency to another using current exchange rates.",
    parameters: {
      type: "object",
      properties: {
        amount: { type: "number", description: "The amount to convert." },
        from: { type: "string", description: "The source currency code, e.g. USD." },
        to: { type: "string", description: "The target currency code, e.g. EUR." },
      },
      required: ["amount", "from", "to"],
    },
  },
};

const PROPOSE_MAP_POINT_TOOL = {
  type: "function",
  function: {
    name: "propose_map_point",
    description:
      "Preview a new point for the user's saved map — use this when the user asks you to write, generate, or create a description for a place (especially one they want added to their map), never for an ordinary factual question (use search_wikipedia for those instead). Write the description yourself in the 'description' argument first. This only geocodes the location and shows a preview on their map for them to accept or dismiss — it does NOT save anything by itself.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A short name for the point, e.g. 'Wells Street Bridge'." },
        location: {
          type: "string",
          description: "The place to geocode, precise enough to find, e.g. 'Wells Street Bridge, Fort Wayne, Indiana'.",
        },
        category: { type: "string", description: "A short category, e.g. 'landmark', 'bridge', 'restaurant'." },
        subcategory: { type: "string", description: "A more specific subcategory, if useful." },
        icon: { type: "string", description: "A single emoji that fits the place, e.g. 🌉 for a bridge." },
        description: { type: "string", description: "The description you wrote for this place, in your own words." },
        tags: {
          type: "array",
          description:
            "Structured header/value labels for this point, e.g. {key: 'architecture', value: 'Victorian'} or {key: 'start_date', value: '1886'}. Call list_saved_tag_keys first and reuse an existing header when one fits, instead of inventing a near-duplicate (e.g. 'architecture' vs 'building_architecture'). Optional — omit if nothing meaningful to tag.",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "The tag header, e.g. 'architecture', 'start_date'." },
              value: { type: "string", description: "The value for that header, e.g. 'Victorian', '1886'." },
            },
            required: ["key", "value"],
          },
        },
      },
      required: ["name", "location", "category", "description"],
    },
  },
};

const FIND_SAVED_POINT_TOOL = {
  type: "function",
  function: {
    name: "find_saved_point",
    description:
      "Search the user's own saved map points by name. Call this before answering a factual question about a specific real-world place, so you can use their saved note as your source and mention it's already on their map instead of searching elsewhere — and before calling propose_map_point, to avoid suggesting a duplicate of something already saved. A match's 'urls' list may include a Wikipedia link even when its 'blurb' is empty or thin — if so, call get_wikipedia_article with that exact URL to get real content instead of guessing. Returns up to 5 matches, or an empty list if nothing matches.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The place name to look for among the user's saved points." },
      },
      required: ["query"],
    },
  },
};

const GET_WIKIPEDIA_ARTICLE_TOOL = {
  type: "function",
  function: {
    name: "get_wikipedia_article",
    description:
      "Fetch a specific Wikipedia article by its exact URL or title — use this instead of search_wikipedia whenever you already know precisely which article you want, e.g. a Wikipedia URL returned by find_saved_point, or a link the user gave you directly. More reliable than a keyword search when you already have the exact title or URL.",
    parameters: {
      type: "object",
      properties: {
        urlOrTitle: { type: "string", description: "A Wikipedia article URL, or its exact title." },
      },
      required: ["urlOrTitle"],
    },
  },
};

const FIND_WIKIPEDIA_ARTICLES_IN_AREA_TOOL = {
  type: "function",
  function: {
    name: "find_wikipedia_articles_in_area",
    description:
      "Find Wikipedia articles located within a geographic area (a county, city, park, etc.) and preview them all as points on the user's map, the same way propose_map_point previews one. Wikipedia's search only reaches about 10km around each point, so a large area is covered by tiling several searches — a very large area (e.g. a whole state) may only be partially covered, which the tool result flags. Use this when the user asks to find, locate, or list Wikipedia articles or landmarks across an area, not for a single specific place.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "The area to search, e.g. 'Steuben County, Indiana'." },
        limit: { type: "number", description: "Max number of articles to return (default 20, max 40)." },
      },
      required: ["location"],
    },
  },
};

const LIST_SAVED_TAG_KEYS_TOOL = {
  type: "function",
  function: {
    name: "list_saved_tag_keys",
    description:
      "List every tag header already used across the user's saved points (e.g. 'architecture', 'start_date'). Call this before tagging a point with propose_map_point so you reuse an existing header instead of inventing a near-duplicate — nothing enforces this, so checking first is the only way headers stay consistent.",
    parameters: { type: "object", properties: {} },
  },
};

const FIND_POINTS_BY_TAG_TOOL = {
  type: "function",
  function: {
    name: "find_points_by_tag",
    description:
      "Find the user's saved points that have a given tag header, optionally filtered to a specific value (e.g. header 'architecture', value 'Victorian'). Use this when the user asks to find or list their points by some attribute rather than by name or location.",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "The tag header to match, e.g. 'architecture'." },
        value: { type: "string", description: "Optional value to also match, e.g. 'Victorian'." },
      },
      required: ["key"],
    },
  },
};

const GET_POINT_TAG_REFERENCE_TOOL = {
  type: "function",
  function: {
    name: "get_point_tag_reference",
    description:
      "Get the full documented reference for this app's own point tags — every known tag header, its accepted values (or format), what it means, and how some combine with others (e.g. military_installation with military_installation_structure, or brand with brand_historic_location). Call this before tagging a point with propose_map_point when one of these documented tags might apply, or before answering a question that depends on them (e.g. 'where is the first McDonald's') — don't guess at a documented tag's exact values from memory.",
    parameters: { type: "object", properties: {} },
  },
};

const DIFFICULTY_CLASSIFIER_PROMPT =
  'Classify whether the user message needs careful multi-step reasoning to answer correctly: a logic puzzle with many interacting constraints, a nontrivial proof, competition-level math, or writing/debugging real code. Everyday questions, conversation, simple facts, and simple arithmetic do NOT count. Reply with exactly "NO" if it does not need that, or "YES: <short reason, under 12 words>" if it does. Reply with nothing else.';

interface DifficultyCheck {
  usage: ChatUsage | null;
  rateLimit: DailyRateLimit | null;
  thinkingRequest: ThinkingRequest | null;
}

// A model asked mid-generation to call a "please let me think harder" tool
// just doesn't reliably do it (confirmed against qwen/qwen3.6-27b on two
// deliberately hard test problems — it attempted both directly rather than
// asking). A dedicated, narrow yes/no classification beforehand is a much
// easier judgment for a model to get right consistently than "decide to
// interrupt yourself mid-answer."
async function checkDifficulty(apiKey: string, message: string): Promise<DifficultyCheck> {
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: DIFFICULTY_CLASSIFIER_PROMPT },
        { role: "user", content: message },
      ],
      reasoning_effort: "none",
      max_completion_tokens: 40,
    }),
  });

  if (res.status === 429) {
    // Groq itself is out of capacity (daily or per-minute) — the caller
    // fails the whole turn over to Gemini rather than trying the main
    // Groq call next, which would just hit the same wall.
    throw new GroqRateLimitError(await res.text().catch(() => "Groq rate limit"), readRetryAfter(res));
  }
  if (!res.ok) {
    // Fail safe: some other classifier hiccup — just skip straight to
    // answering normally rather than blocking the user over this.
    return { usage: null, rateLimit: null, thinkingRequest: null };
  }

  const limitRequestsHeader = res.headers.get("x-ratelimit-limit-requests");
  const remainingRequestsHeader = res.headers.get("x-ratelimit-remaining-requests");
  const rateLimit: DailyRateLimit | null =
    limitRequestsHeader && remainingRequestsHeader
      ? { limitRequests: Number(limitRequestsHeader), remainingRequests: Number(remainingRequestsHeader) }
      : null;

  const data = (await res.json()) as GroqChatResponse;
  const usage: ChatUsage | null = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        contextWindow: CONTEXT_WINDOW_TOKENS,
      }
    : null;

  const text = (data.choices[0]?.message.content ?? "").trim();
  if (!/^yes/i.test(text)) {
    return { usage, rateLimit, thinkingRequest: null };
  }
  const reason = text.replace(/^yes:?\s*/i, "").trim() || "This looks like it needs careful step-by-step thinking.";
  return { usage, rateLimit, thinkingRequest: { reason } };
}

function regionsFromReply(reply: string): MapData | null {
  const found = extractRegionsFromText(reply);
  if (!found) return null;
  return { kind: "regions", points: [], regionType: found.regionType, regions: found.regions };
}

// A plain "call the tool if you need it" instruction wasn't reliable enough
// in practice — confirmed live: asking for a multi-day forecast produced a
// fully fabricated 7-day forecast with plausible-looking fake numbers and
// toolsUsed: [], meaning the model never called get_weather_forecast at
// all. Forecasts seem to be exactly the kind of thing a model has a
// confident-sounding prior for, unlike an exact current temperature or a
// live alert status (both of which route to their tools reliably). Rather
// than keep tuning wording, detect the pattern up front and force the tool
// call on the first turn — the model still writes the final reply, it just
// can't skip the tool.
const FORECAST_KEYWORD = /\bforecast\b/i;
const FUTURE_WEATHER_PHRASE =
  /\b(tomorrow|tonight|this week|next week|this weekend|next weekend|coming days|next few days|later this week)\b/i;
const WEATHER_TOPIC_WORD = /\b(weather|rain|snow|temperature|hot|cold|sunny|cloudy|storm)\b/i;

function looksLikeForecastRequest(message: string): boolean {
  if (FORECAST_KEYWORD.test(message)) return true;
  return FUTURE_WEATHER_PHRASE.test(message) && WEATHER_TOPIC_WORD.test(message);
}

function parseTagsArg(value: unknown): PointTag[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tags: PointTag[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object" && typeof (entry as any).key === "string" && typeof (entry as any).value === "string") {
      tags.push({ key: (entry as any).key, value: (entry as any).value });
    }
  }
  return tags;
}

// A tool's own result object only carries an `error` key when something
// genuinely went wrong (a network failure, an upstream API being down) —
// but find_saved_point/find_points_by_tag never error, they just come back
// with no matches, which for "is this actually on the user's map" purposes
// is the same kind of failure the API-used badge needs to surface. Shared
// by both providers so a Wikipedia timeout looks the same whether Groq or
// Gemini hit it.
const EMPTY_MATCH_MEANS_FAILED = new Set(["find_saved_point", "find_points_by_tag"]);

export function didToolCallFail(name: string, result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if ("error" in result) return true;
  if (EMPTY_MATCH_MEANS_FAILED.has(name) && "matches" in result) {
    const matches = (result as { matches: unknown }).matches;
    return Array.isArray(matches) && matches.length === 0;
  }
  return false;
}

async function executeTool(
  call: ToolCall,
  userId: string,
  // Tool names already called earlier in this same turn — lets
  // propose_map_point enforce that a real grounding search happened first,
  // rather than trusting the system prompt's wording alone (which the model
  // doesn't reliably follow: it would sometimes invent specifics like an
  // architectural style or a National Register listing with no source).
  groundedTools: ReadonlySet<string>
): Promise<{ result: unknown; mapData: MapData | null; layerCommand?: LayerCommand | null }> {
  const name = call.function.name;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return { result: { error: "Could not parse tool arguments" }, mapData: null };
  }

  if (name === "search_wikipedia") {
    if (typeof args.query !== "string" || !args.query) {
      return { result: { error: "Missing required 'query' argument" }, mapData: null };
    }
    const result = await searchWikipedia(args.query);
    if ("error" in result || !result.coordinates) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "landmark",
        points: [
          {
            label: result.title,
            lat: result.coordinates.lat,
            lon: result.coordinates.lon,
            icon: "📖",
            category: "landmark",
            urls: [result.url],
            blurb: result.summary,
          },
        ],
      },
    };
  }

  if (name === "search_web") {
    if (typeof args.query !== "string" || !args.query) {
      return { result: { error: "Missing required 'query' argument" }, mapData: null };
    }
    const result = await searchWeb(args.query);
    return { result, mapData: null };
  }

  if (name === "get_wikipedia_article") {
    if (typeof args.urlOrTitle !== "string" || !args.urlOrTitle) {
      return { result: { error: "Missing required 'urlOrTitle' argument" }, mapData: null };
    }
    const title = wikipediaTitleFromUrl(args.urlOrTitle) ?? args.urlOrTitle;
    const result = await getWikipediaByTitle(title);
    // No mapData here — this is for grounding an answer about a place that's
    // already on the user's map (via find_saved_point), not for dropping a
    // second, duplicate pin.
    return { result, mapData: null };
  }

  if (name === "find_places") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const category = typeof args.category === "string" && args.category ? args.category : "restaurant";
    const result = await findPlaces(args.location, category);
    if ("error" in result) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "places",
        points: result.places.map((p) => ({
          label: p.name,
          lat: p.lat,
          lon: p.lon,
          address: p.address,
          icon: categoryIcon(result.category),
          category: result.category,
        })),
      },
    };
  }

  if (name === "calculate_distance") {
    if (typeof args.from !== "string" || !args.from || typeof args.to !== "string" || !args.to) {
      return { result: { error: "Missing required 'from'/'to' arguments" }, mapData: null };
    }
    const result = await calculateDistance(args.from, args.to);
    if ("error" in result) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "distance",
        points: [
          { label: args.from, lat: result.from.lat, lon: result.from.lon },
          { label: args.to, lat: result.to.lat, lon: result.to.lon },
        ],
        distanceMiles: result.distanceMiles,
        distanceKm: result.distanceKm,
      },
    };
  }

  if (name === "highlight_regions") {
    const regionType = args.regionType;
    if (regionType !== "us_state" && regionType !== "country") {
      return { result: { error: "regionType must be 'us_state' or 'country'" }, mapData: null };
    }
    if (!Array.isArray(args.names) || args.names.some((n) => typeof n !== "string")) {
      return { result: { error: "Missing required 'names' array" }, mapData: null };
    }
    const matches = findRegions(regionType, args.names as string[]);
    if ("error" in matches) return { result: matches, mapData: null };
    return {
      result: { matched: matches.map((m) => m.name) },
      mapData: {
        kind: "regions",
        points: [],
        regionType,
        regions: matches,
      },
    };
  }

  if (name === "verify_map") {
    if (typeof args.topic !== "string" || !args.topic) {
      return { result: { error: "Missing required 'topic' argument" }, mapData: null };
    }
    const regionType = args.regionType;
    if (regionType !== "us_state" && regionType !== "country") {
      return { result: { error: "regionType must be 'us_state' or 'country'" }, mapData: null };
    }
    const verified = await verifyRegionStatuses(args.topic, regionType);
    if ("error" in verified) return { result: verified, mapData: null };
    return { result: { verified: true }, mapData: verified.mapData };
  }

  if (name === "get_weather") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getConditions(args.location);
    if ("error" in result) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "landmark",
        points: [
          {
            label: result.location,
            lat: result.lat,
            lon: result.lon,
            icon: result.icon,
            category: "weather",
            blurb: `${result.temperatureF}°F, ${result.condition}. Humidity ${result.humidity}%, wind ${result.windMph} mph.`,
          },
        ],
      },
    };
  }

  if (name === "get_weather_forecast") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const days = typeof args.days === "number" ? args.days : 5;

    // NWS's forecast is higher quality (detailed prose, twice-daily periods)
    // but only covers the US — try it first and quietly fall back to
    // Open-Meteo (worldwide) when the location is outside its coverage.
    const nws = await getNwsForecast(args.location, days * 2);
    if (!("error" in nws)) {
      return {
        result: nws,
        mapData: {
          kind: "landmark",
          points: [
            {
              label: nws.location,
              lat: nws.lat,
              lon: nws.lon,
              icon: "🌡️",
              category: "forecast",
              blurb: nws.periods
                .map(
                  (p) =>
                    `${p.name}: ${p.shortForecast}, ${p.temperatureF}°F${p.precipitationChance != null ? `, ${p.precipitationChance}% precip` : ""}`
                )
                .join("\n"),
            },
          ],
        },
      };
    }

    const result = await getForecast(args.location, days);
    if ("error" in result) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "landmark",
        points: [
          {
            label: result.location,
            lat: result.lat,
            lon: result.lon,
            icon: result.days[0]?.icon ?? "🌡️",
            category: "forecast",
            blurb: result.days
              .map((d) => `${d.date}: ${d.icon} ${d.condition}, ${d.lowF}–${d.highF}°F, ${d.precipitationChance}% precip`)
              .join("\n"),
          },
        ],
      },
    };
  }

  if (name === "get_weather_alerts") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getActiveAlerts(args.location);
    if ("error" in result) return { result, mapData: null };
    if (result.alerts.length === 0) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "landmark",
        points: [
          {
            label: result.location,
            lat: result.lat,
            lon: result.lon,
            icon: "⚠️",
            category: "weather alert",
            blurb: result.alerts.map((a) => `${a.event}: ${a.headline}`).join("\n"),
          },
        ],
      },
    };
  }

  if (name === "get_air_quality") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getAirQuality(args.location);
    if ("error" in result) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "landmark",
        points: [
          {
            label: result.location,
            lat: result.lat,
            lon: result.lon,
            icon: "🌬️",
            category: "air quality",
            blurb: `AQI ${result.aqi ?? "?"} (${result.category}). PM2.5 ${result.pm2_5 ?? "?"} µg/m³, PM10 ${result.pm10 ?? "?"} µg/m³, ozone ${result.ozone ?? "?"} µg/m³.`,
          },
        ],
      },
    };
  }

  if (name === "find_flights_near") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const center = await geocode(args.location);
    if ("error" in center) return { result: center, mapData: null };
    const radiusKm = Math.min(typeof args.radiusKm === "number" ? args.radiusKm : 50, 200);
    const dLat = radiusKm / 111;
    const dLon = radiusKm / (111 * Math.cos((center.lat * Math.PI) / 180) || 1);
    const flights = await getFlightsInBoundingBox({
      south: center.lat - dLat,
      west: center.lon - dLon,
      north: center.lat + dLat,
      east: center.lon + dLon,
    });
    if ("error" in flights) return { result: flights, mapData: null };
    if (flights.length === 0) {
      return { result: { message: `No flights currently detected near ${center.name}` }, mapData: null };
    }
    const shown = flights.slice(0, 30);
    return {
      result: {
        count: flights.length,
        flights: shown.map((f) => ({
          callsign: f.callsign,
          originCountry: f.originCountry,
          altitudeFt: f.altitudeFt,
          velocityMph: f.velocityMph,
        })),
      },
      mapData: { kind: "flights", points: shown.map(flightToMapPoint) },
    };
  }

  if (name === "set_map_layer") {
    const layer = args.layer;
    if (layer !== "radar" && layer !== "timezones" && layer !== "pins" && layer !== "flights" && layer !== "wikipedia") {
      return {
        result: { error: "layer must be 'radar', 'timezones', 'pins', 'flights', or 'wikipedia'" },
        mapData: null,
      };
    }
    if (typeof args.enabled !== "boolean") {
      return { result: { error: "Missing required 'enabled' boolean argument" }, mapData: null };
    }
    return { result: { ok: true }, mapData: null, layerCommand: { layer, enabled: args.enabled } };
  }

  if (name === "get_local_time") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getConditions(args.location);
    if ("error" in result) return { result, mapData: null };
    return {
      result: { location: result.location, timezone: result.timezone, localTime: result.localTime },
      mapData: {
        kind: "landmark",
        points: [
          {
            label: result.location,
            lat: result.lat,
            lon: result.lon,
            icon: "🕒",
            category: "time zone",
            blurb: `Local time: ${result.localTime} (${result.timezone}, ${result.timezoneAbbreviation})`,
          },
        ],
      },
    };
  }

  if (name === "convert_currency") {
    if (typeof args.amount !== "number" || typeof args.from !== "string" || typeof args.to !== "string") {
      return { result: { error: "Missing required 'amount'/'from'/'to' arguments" }, mapData: null };
    }
    return { result: await convertCurrency(args.amount, args.from, args.to), mapData: null };
  }

  if (name === "propose_map_point") {
    if (
      typeof args.name !== "string" ||
      !args.name ||
      typeof args.location !== "string" ||
      !args.location ||
      typeof args.description !== "string" ||
      !args.description
    ) {
      return { result: { error: "Missing required 'name'/'location'/'description' arguments" }, mapData: null };
    }
    if (!groundedTools.has("search_wikipedia") && !groundedTools.has("search_web")) {
      return {
        result: {
          error:
            "Call search_wikipedia (or search_web if that finds nothing relevant) for this place first, then call propose_map_point again — even if you already believe you know real facts about it, since that belief is exactly what's caused made-up specifics before.",
        },
        mapData: null,
      };
    }
    const geo = await geocode(args.location);
    if ("error" in geo) return { result: geo, mapData: null };
    return {
      result: { name: args.name, lat: geo.lat, lon: geo.lon },
      mapData: {
        kind: "point_suggestion",
        points: [
          {
            label: args.name,
            lat: geo.lat,
            lon: geo.lon,
            icon: typeof args.icon === "string" && args.icon ? args.icon : "📍",
            category: typeof args.category === "string" ? args.category : "",
            subcategory: typeof args.subcategory === "string" ? args.subcategory : undefined,
            blurb: args.description,
            tags: parseTagsArg(args.tags),
          },
        ],
      },
    };
  }

  if (name === "find_saved_point") {
    if (typeof args.query !== "string" || !args.query) {
      return { result: { error: "Missing required 'query' argument" }, mapData: null };
    }
    const rows = await findMapPointsByName(userId, args.query);
    return {
      result: {
        matches: rows.map((r) => ({
          name: r.name,
          category: r.category,
          subcategory: r.subcategory,
          icon: r.icon,
          lat: r.lat,
          lon: r.lon,
          blurb: r.blurb,
          urls: JSON.parse(r.urls_json),
          tags: JSON.parse(r.tags_json),
        })),
      },
      mapData: null,
    };
  }

  if (name === "list_saved_tag_keys") {
    return { result: { keys: await getDistinctTagKeys(userId) }, mapData: null };
  }

  if (name === "get_point_tag_reference") {
    return { result: { reference: await getPointTagReference() }, mapData: null };
  }

  if (name === "find_points_by_tag") {
    if (typeof args.key !== "string" || !args.key) {
      return { result: { error: "Missing required 'key' argument" }, mapData: null };
    }
    const value = typeof args.value === "string" ? args.value : undefined;
    const rows = await findMapPointsByTag(userId, args.key, value);
    return {
      result: {
        matches: rows.map((r) => ({
          name: r.name,
          category: r.category,
          subcategory: r.subcategory,
          lat: r.lat,
          lon: r.lon,
          blurb: r.blurb,
          tags: JSON.parse(r.tags_json),
        })),
      },
      mapData: null,
    };
  }

  if (name === "find_wikipedia_articles_in_area") {
    if (typeof args.location !== "string" || !args.location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const area = await geocodeArea(args.location);
    if ("error" in area) return { result: area, mapData: null };
    const limit = typeof args.limit === "number" ? Math.min(Math.max(1, Math.round(args.limit)), 40) : 20;
    const { articles, areaTooLarge } = await findArticlesInArea(area.boundingBox, limit);
    if (articles.length === 0) {
      return { result: { error: `No Wikipedia articles found in ${area.name}` }, mapData: null };
    }
    return {
      result: { count: articles.length, areaTooLarge, titles: articles.map((a) => a.title) },
      mapData: {
        kind: "point_suggestion",
        points: articles.map((a) => ({
          label: a.title,
          lat: a.lat,
          lon: a.lon,
          icon: "📖",
          category: "landmark",
          urls: [a.url],
          blurb: a.extract,
        })),
      },
    };
  }

  return { result: { error: `Unknown tool: ${name}` }, mapData: null };
}

// No real tokenizer on hand server-side; a rough chars/4 estimate is only used
// to decide *before* sending whether to trim history. The actual usage
// numbers we report back come from Groq's response, not this estimate.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildSystemPrompt(assistantName: string, instructions: string): string {
  return [
    `You are ${assistantName}, a helpful personal assistant.`,
    "Reply in plain conversational text — no markdown (no **bold**, headers, tables, or bullet lists with *dashes) since replies are shown as plain text and sometimes read aloud.",
    "Give one direct, confident answer and stop — never think out loud, list multiple candidate answers, or write several paragraphs that each revise or contradict what you just said. Settle on your best answer before responding and state it once.",
    "You can look things up on Wikipedia with the search_wikipedia tool when a question needs a factual answer you're not confident about. Don't narrate that you used a tool or which source you checked — the app shows that separately, so just answer directly.",
    "Wikipedia's search matches keywords, not questions — searching the literal question text (e.g. 'oldest building in New York City') often returns an unrelated top result. Instead, identify the specific person/place/thing the question is most likely about from your own knowledge first, then search for that specific name to confirm and get details — never repeat the raw question as the search query.",
    "Only state facts the tool result actually contains — don't add extra specifics (an address, neighborhood, exact date, etc.) from your own memory that the result didn't confirm.",
    "For information Wikipedia wouldn't have — a local business, current news, product details, prices, hours, or a real place too small or obscure for its own Wikipedia article — use search_web instead. Try search_wikipedia first for a well-known person, place, or topic; fall back to search_web when it returns nothing relevant, and likewise only state what the results actually say.",
    "You can find nearby restaurants, cafes, bars, or fast food with the find_places tool, and calculate the straight-line distance between two locations with the calculate_distance tool — results from either also appear on the user's map.",
    "When a factual answer from search_wikipedia is about a specific real-world place, it may also drop a pin on the user's map automatically.",
    "When the answer to a question is naturally a set of US states or countries (e.g. every state where something is legal), answer normally in text AND call highlight_regions with the full list so it also shades them on the map — you determine the list yourself, the tool only draws it.",
    "If the user asks to verify, double-check, reload, or fill in a states/countries map more exactly — including right after you or they just brought one up — call verify_map with the topic and regionType inferred from the conversation so far; it checks every region individually rather than a quick pass.",
    "You have no built-in way to know real current or future weather — never guess, estimate, or state specific temperatures, conditions, or precipitation chances from your own knowledge, even for a well-known climate (e.g. 'it's probably mild there this time of year'). Always call a tool: get_weather for current conditions, or get_weather_forecast for tomorrow, this week, or any future day — call the forecast tool once even for a multi-day range like 'this weekend' rather than repeatedly. Both also drop a pin on the user's map. You can also convert between currencies with convert_currency using live exchange rates.",
    "For US locations, get_weather_alerts checks active severe weather warnings/watches/advisories, and get_air_quality (worldwide) checks current AQI and pollutant levels — use these for storm-warning or air-quality/pollution questions rather than folding that into get_weather.",
    "find_flights_near shows live aircraft currently flying near a location, via OpenSky — use it when the user asks what's flying overhead or near somewhere; it's a live snapshot, not saved to their map.",
    "You can turn a map layer on or off for the user with set_map_layer — 'radar' (live weather radar overlay), 'timezones' (time zone bands), 'pins' (their saved points), 'flights' (a live-updating layer of nearby aircraft), or 'wikipedia' (nearby geotagged Wikipedia articles, browsable right on the map) — whenever they ask to show, hide, turn on/off, or toggle one of these. Never say a layer is now on or off unless you actually called set_map_layer this turn — claiming it without calling the tool leaves the map unchanged and misleads them.",
    "You have no built-in way to know the real current date or time — never guess, compute, or state a specific current time or date on your own, even one that seems obviously derivable (e.g. from a timezone offset), since you can't verify it's actually correct right now. Always call get_local_time for any question about the current time, date, or day somewhere; it also drops a pin on the user's map.",
    "If the user asks you to write, generate, or create a description for a place — especially one they want added to their map — and it's a specific named real-world building or landmark you don't already have solid, confident knowledge of (most of them), call search_wikipedia for it first rather than writing from scratch; a specific-sounding name doesn't mean you actually know real details about it. If that returns nothing relevant, try search_web next — plenty of real local landmarks, historic buildings, and small businesses have no Wikipedia article but do have other real coverage online. If either turns up a genuine match, ground the description in those real facts. If neither does, or the place is clearly personal/generic rather than a notable landmark (someone's favorite coffee shop, a business with no real public record), write a general description in your own words — but never state a specific street address, exact founding/built year, county, or named historical figure as fact unless a real source actually confirmed it; when you don't know a specific like that, leave it out or say it's not something you could confirm rather than inventing a plausible-sounding one. Then call propose_map_point with that place's name, a location string precise enough to geocode (include the city/state/country), a category, and your description; this only previews the point on their map, it does not save it. In your reply, share the description and explicitly ask whether they'd like it added — never say you've already added it, and never call propose_map_point, search_wikipedia, or search_web more than once each for the same request.",
    "Before answering a factual question about one specific real-world place, or before calling propose_map_point for one, call find_saved_point first to check whether the user already has it saved — if so, use their saved note as your source and mention it's already on their map instead of searching elsewhere or suggesting a duplicate. If the saved match's blurb is empty or thin but its urls list includes a Wikipedia link, call get_wikipedia_article with that exact URL to get real content instead of guessing — it's more reliable than a fresh keyword search since you already know exactly which article it is.",
    "If the user asks you to find, locate, or list Wikipedia articles or landmarks across a whole area (a county, city, park — not one specific place), call find_wikipedia_articles_in_area instead of search_wikipedia; it previews every result on their map at once. Mention how many were found and ask if they'd like them added — if the tool result says the area was too large to fully cover, say so rather than implying the list is complete.",
    "Points can carry tags — header/value pairs like {key: 'architecture', value: 'Victorian'} or {key: 'start_date', value: '1886'} — for attributes worth searching on later. When you have something worth tagging on a point you're proposing with propose_map_point, call list_saved_tag_keys first and reuse a header already in use whenever one fits (e.g. always 'architecture', never a near-duplicate like 'building_architecture') — nothing else enforces that consistency. 'architecture' (an architectural style) and 'start_date' (when something was built or established, as a plain year like '1886' or a date) are common headers worth setting on landmarks and buildings when you know them; add other headers freely when something else about the place is worth tagging. If the user asks to find their points by some attribute (e.g. 'my Victorian buildings'), call find_points_by_tag.",
    "Beyond architecture/start_date, this app has a growing documented set of standard tags (start_date, end_date, building, building_type, water_type, current, military_installation, military_installation_structure, amenity, brand, name, brand_historic_location) with fixed accepted values and specific meanings — call get_point_tag_reference for the full reference (values, meaning, how some combine) whenever tagging a point with propose_map_point might warrant one of these, or before answering a question that depends on one; don't guess at a documented tag's exact values from memory, since getting one wrong (e.g. inventing a value not in the real set) makes it useless for future searches. A tag's stored value can itself combine more than one applicable value, joined by ';' with no surrounding spaces (e.g. brand_historic_location: 'first;registered').",
    "For a question like 'where is the first McDonald's' — a specific location of a named brand — call find_points_by_tag with key 'brand' and the brand's name as value; each match comes back with its full tags, so check brand_historic_location on each for 'first' (find_points_by_tag's value match is a substring, so searching 'first' there already also catches 'first_with_name' and 'first_without_name' in one call — see get_point_tag_reference for what those mean and how to pick between them if more than one location comes back). If nothing turns up — no matching brand tag at all, or none with a relevant brand_historic_location — say plainly that it doesn't look like it's saved on the map yet, then go ahead and call search_wikipedia or search_web to actually answer it instead of relying on memory alone; the map lookup having come up empty is exactly why an external search is warranted here, not a reason to skip one. Always call find_points_by_tag before either of those for this kind of question (even though it'll come back empty) — that's what shows the map search as attempted-and-failed for this reply rather than skipped, since both it and whichever search you fall back to end up listed together as this reply's sources.",
    instructions ? `Follow these instructions from your user: ${instructions}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function trimHistory(
  history: ChatTurn[],
  systemPrompt: string,
  message: string
): { history: ChatTurn[]; droppedMessages: number } {
  let trimmed = history;
  let droppedMessages = 0;
  const threshold = CONTEXT_WINDOW_TOKENS * COMPRESSION_THRESHOLD_RATIO;

  function estimateTotal(h: ChatTurn[]): number {
    return (
      estimateTokens(systemPrompt) +
      estimateTokens(message) +
      h.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
    );
  }

  // Drop the oldest turns two at a time (a user/assistant pair) to keep the
  // remaining history alternating sensibly.
  while (trimmed.length > 0 && estimateTotal(trimmed) > threshold) {
    trimmed = trimmed.slice(2);
    droppedMessages += 2;
  }
  return { history: trimmed, droppedMessages };
}

function blankResult(reply: string, droppedMessages: number): ChatResult {
  return {
    reply,
    usage: null,
    compressed: droppedMessages > 0,
    droppedMessages,
    rateLimit: null,
    thinkingRequest: null,
    provider: null,
    providerNote: null,
    mapData: null,
    layerCommand: null,
    toolsUsed: [],
    toolsFailed: [],
  };
}

// The actual Groq tool-calling turn — factored out so it can run either as
// the everyday default or as Gemini's backup when Gemini is the user's
// chosen default and happens to be down. Throws GroqRateLimitError on a 429
// so either caller can decide how to fail over.
// Every tool Groq is offered on each turn, regardless of whether the
// message needs one — hoisted to module scope (rather than rebuilt inside
// runGroqPath every call) so GROQ_TOOLS_TOKEN_ESTIMATE below only has to
// serialize it once.
const GROQ_TOOLS = [
  SEARCH_WIKIPEDIA_TOOL,
  SEARCH_WEB_TOOL,
  FIND_PLACES_TOOL,
  CALCULATE_DISTANCE_TOOL,
  HIGHLIGHT_REGIONS_TOOL,
  VERIFY_MAP_TOOL,
  GET_WEATHER_TOOL,
  GET_LOCAL_TIME_TOOL,
  CONVERT_CURRENCY_TOOL,
  PROPOSE_MAP_POINT_TOOL,
  FIND_SAVED_POINT_TOOL,
  FIND_WIKIPEDIA_ARTICLES_IN_AREA_TOOL,
  GET_WIKIPEDIA_ARTICLE_TOOL,
  LIST_SAVED_TAG_KEYS_TOOL,
  FIND_POINTS_BY_TAG_TOOL,
  GET_POINT_TAG_REFERENCE_TOOL,
  GET_WEATHER_FORECAST_TOOL,
  GET_WEATHER_ALERTS_TOOL,
  GET_AIR_QUALITY_TOOL,
  FIND_FLIGHTS_NEAR_TOOL,
  SET_MAP_LAYER_TOOL,
];

// trimHistory's threshold is sized against the model's full context window
// (131k tokens) — the right ceiling for deciding when a conversation is
// getting *unmanageably* long, but Groq's free-tier plan enforces a much
// tighter per-minute input-token cap (observed: 7000) that has nothing to
// do with context window size. Worse, trimHistory's estimate only counts
// the system prompt, history, and message — never the ~19 tool schemas
// (~3,600 tokens) sent on every single request regardless of history
// length. Combined with the system prompt itself (~1,800 tokens), fixed
// per-request overhead alone eats most of that 7000 budget before any
// history is added, so a conversation trimHistory considers nowhere near
// full could still blow the real per-minute cap (confirmed in production:
// a short message with modest history hit a 413 "too large" from Groq).
// This is a second, tighter trim specifically for what's about to be sent
// to Groq — Gemini's much larger budget is unaffected.
const GROQ_TOOLS_TOKEN_ESTIMATE = estimateTokens(JSON.stringify(GROQ_TOOLS));
const GROQ_SAFE_REQUEST_TOKENS = 6000;

function trimHistoryForGroq(
  history: ChatTurn[],
  droppedMessages: number,
  systemPrompt: string,
  message: string
): { history: ChatTurn[]; droppedMessages: number } {
  let trimmed = history;
  let dropped = droppedMessages;

  function estimateTotal(h: ChatTurn[]): number {
    return (
      GROQ_TOOLS_TOKEN_ESTIMATE +
      estimateTokens(systemPrompt) +
      estimateTokens(message) +
      h.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
    );
  }

  while (trimmed.length > 0 && estimateTotal(trimmed) > GROQ_SAFE_REQUEST_TOKENS) {
    trimmed = trimmed.slice(2);
    dropped += 2;
  }
  return { history: trimmed, droppedMessages: dropped };
}

async function runGroqPath(params: {
  apiKey: string;
  userId: string;
  systemPrompt: string;
  message: string;
  history: ChatTurn[];
  droppedMessages: number;
  offerThinkingTool: boolean;
}): Promise<ChatResult> {
  const { apiKey, userId, systemPrompt, message, offerThinkingTool } = params;
  const { history, droppedMessages } = trimHistoryForGroq(
    params.history,
    params.droppedMessages,
    systemPrompt,
    message
  );

  // Ask a narrow yes/no question up front rather than hoping the model
  // interrupts its own answer to flag difficulty (see checkDifficulty).
  let usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let rateLimit: DailyRateLimit | null = null;
  let mapData: MapData | null = null;
  let layerCommand: LayerCommand | null = null;
  // Every tool called this turn regardless of outcome — propose_map_point's
  // grounding check (has search_wikipedia/search_web actually run yet?)
  // cares only that the call happened, not whether it succeeded. Kept
  // separate from toolsUsed/toolsFailed below, which split on outcome for
  // the client's API-used badge.
  const calledTools = new Set<string>();
  const toolsUsed = new Set<string>();
  const toolsFailed = new Set<string>();

  if (offerThinkingTool) {
    const check = await checkDifficulty(apiKey, message);
    if (check.usage) {
      usageTotals = {
        promptTokens: check.usage.promptTokens,
        completionTokens: check.usage.completionTokens,
        totalTokens: check.usage.totalTokens,
      };
    }
    rateLimit = check.rateLimit;
    if (check.thinkingRequest) {
      return {
        reply: null,
        usage: check.usage,
        compressed: false,
        droppedMessages: 0,
        rateLimit,
        thinkingRequest: check.thinkingRequest,
        provider: null,
        providerNote: null,
        mapData: null,
        layerCommand: null,
        toolsUsed: [],
        toolsFailed: [],
      };
    }
  }

  const messages: GroqMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((turn): GroqMessage => ({ role: turn.role, content: turn.content })),
    { role: "user", content: message },
  ];

  const forceForecastTool = looksLikeForecastRequest(message);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const res = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        tools: GROQ_TOOLS,
        tool_choice:
          iteration === 0 && forceForecastTool
            ? { type: "function", function: { name: "get_weather_forecast" } }
            : "auto",
        // Qwen3.6 defaults to an extended "thinking" mode that can burn
        // hundreds of output tokens on even a one-line reply — easily
        // enough to trip Groq's free-tier output-tokens-per-minute cap
        // (1,000/min) after just one or two messages. "none" is documented
        // as the mode for general-purpose dialogue. Approved deep-thinking
        // requests never reach this call at all — they're routed to Gemini
        // above, since Groq's ~900-token reply ceiling (declaring more gets
        // rejected outright regardless of mode) leaves no room for both
        // extended reasoning and a full answer.
        reasoning_effort: "none",
        max_completion_tokens: 900,
      }),
    });

    // 413 is Groq's status for "this request's tokens exceed the per-minute
    // cap" (its own error body even carries code: "rate_limit_exceeded") —
    // a capacity problem exactly like 429, just reported differently since
    // it's triggered by one oversized request rather than call frequency.
    // Treating it as a plain error here meant it skipped the Gemini
    // fallback entirely and leaked Groq's raw error text to the user.
    if (res.status === 429 || res.status === 413) {
      throw new GroqRateLimitError(await res.text().catch(() => "Groq rate limit"), readRetryAfter(res));
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Groq request failed (${res.status}): ${detail}`);
    }

    const limitRequestsHeader = res.headers.get("x-ratelimit-limit-requests");
    const remainingRequestsHeader = res.headers.get("x-ratelimit-remaining-requests");
    if (limitRequestsHeader && remainingRequestsHeader) {
      rateLimit = {
        limitRequests: Number(limitRequestsHeader),
        remainingRequests: Number(remainingRequestsHeader),
      };
    }

    const data = (await res.json()) as GroqChatResponse;
    if (data.usage) {
      usageTotals = {
        promptTokens: usageTotals.promptTokens + data.usage.prompt_tokens,
        completionTokens: usageTotals.completionTokens + data.usage.completion_tokens,
        totalTokens: usageTotals.totalTokens + data.usage.total_tokens,
      };
    }

    const responseMessage = data.choices[0]?.message;
    const usage: ChatUsage | null =
      usageTotals.totalTokens > 0 ? { ...usageTotals, contextWindow: CONTEXT_WINDOW_TOKENS } : null;

    if (!responseMessage?.tool_calls || responseMessage.tool_calls.length === 0) {
      const reply = responseMessage?.content?.trim() ? responseMessage.content : "(empty response from model)";
      return {
        reply,
        usage,
        compressed: droppedMessages > 0,
        droppedMessages,
        rateLimit,
        thinkingRequest: null,
        provider: "groq",
        providerNote: null,
        mapData: mapData ?? regionsFromReply(reply),
        layerCommand,
        toolsUsed: [...toolsUsed],
        toolsFailed: [...toolsFailed],
      };
    }

    messages.push({ role: "assistant", content: responseMessage.content, tool_calls: responseMessage.tool_calls });
    for (const call of responseMessage.tool_calls) {
      const { result, mapData: toolMapData, layerCommand: toolLayerCommand } = await executeTool(call, userId, calledTools);
      calledTools.add(call.function.name);
      if (didToolCallFail(call.function.name, result)) {
        toolsFailed.add(call.function.name);
      } else {
        toolsUsed.add(call.function.name);
      }
      if (toolMapData) mapData = toolMapData;
      if (toolLayerCommand) layerCommand = toolLayerCommand;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    reply: "I was looking into that but couldn't wrap it up — could you try asking again?",
    usage: usageTotals.totalTokens > 0 ? { ...usageTotals, contextWindow: CONTEXT_WINDOW_TOKENS } : null,
    compressed: droppedMessages > 0,
    droppedMessages,
    rateLimit,
    thinkingRequest: null,
    provider: "groq",
    providerNote: null,
    mapData,
    layerCommand,
    toolsUsed: [...toolsUsed],
    toolsFailed: [...toolsFailed],
  };
}

export async function getAssistantReply(params: {
  userId: string;
  assistantName: string;
  instructions: string;
  message: string;
  history: ChatTurn[];
  forceReasoningEffort?: "default" | "none";
  // Which provider handles everyday chat for this user — set in Settings.
  // Defaults to "groq". The other provider is still used as an automatic
  // backup if the preferred one is down, regardless of which is preferred.
  preferredProvider?: Provider;
}): Promise<ChatResult> {
  const groqKey = process.env.GROQ_API_KEY;
  const preferred = params.preferredProvider ?? "groq";

  const systemPrompt = buildSystemPrompt(params.assistantName, params.instructions);
  const { history, droppedMessages } = trimHistory(params.history, systemPrompt, params.message);

  // The user already approved deep thinking (a prior call's checkDifficulty
  // returned a thinkingRequest and they clicked yes) — hand this one to
  // Gemini regardless of the preferred provider. See getGeminiReply for why.
  if (params.forceReasoningEffort === "default") {
    const result = await getGeminiReply({
      userId: params.userId,
      systemPrompt,
      message: params.message,
      history,
      droppedMessages,
      thinking: true,
    });
    return { ...result, provider: "gemini", providerNote: null };
  }

  if (preferred === "gemini") {
    try {
      const result = await getGeminiReply({
        userId: params.userId,
        systemPrompt,
        message: params.message,
        history,
        droppedMessages,
        thinking: false,
      });
      return { ...result, provider: "gemini", providerNote: null };
    } catch (err) {
      // The user's chosen default failing is worth knowing why (bad request,
      // Gemini's own rate limit, a network blip) even though the reply text
      // just says "unavailable" — this was previously swallowed entirely,
      // making a report like "it used Groq even though I set Gemini" and
      // "Gemini hit some other error" indistinguishable from server logs.
      console.error("Gemini (preferred) failed, falling back to Groq:", err);
      if (!groqKey) {
        // A real failure, not a "not configured yet" dev state — surfacing it
        // as a thrown error (rather than a normal 200 reply) is what gives
        // the client's retry-button logic something to catch onto.
        throw new Error("Gemini (your default) is unavailable right now, and no backup model is configured.");
      }
      try {
        const result = await runGroqPath({
          apiKey: groqKey,
          userId: params.userId,
          systemPrompt,
          message: params.message,
          history,
          droppedMessages,
          offerThinkingTool: false,
        });
        return { ...result, providerNote: "Gemini (your default) was unavailable, so this reply came from Groq instead." };
      } catch (groqErr) {
        if (!(groqErr instanceof GroqRateLimitError)) throw groqErr;
        console.error("Groq backup also failed after Gemini:", groqErr);
        throw new Error(
          "Gemini (your default) is unavailable, and Groq — its backup — has also hit its limit right now. Please try again in a moment."
        );
      }
    }
  }

  // preferred === "groq" (the original, default behavior).
  if (!groqKey) {
    return blankResult(
      `${params.assistantName}: I heard "${params.message}". (No model wired up yet — set GROQ_API_KEY to enable real replies.)`,
      0
    );
  }

  try {
    return await runGroqPath({
      apiKey: groqKey,
      userId: params.userId,
      systemPrompt,
      message: params.message,
      history,
      droppedMessages,
      offerThinkingTool: !params.forceReasoningEffort,
    });
  } catch (err) {
    if (!(err instanceof GroqRateLimitError)) {
      throw err;
    }
    // Groq is out of capacity for now (daily or per-minute) — Gemini picks
    // up this turn instead of failing the message outright. It gets the
    // same trimmed history, so the conversation continues without a gap.
    const retrySuffix =
      err.retryAfterSeconds != null ? ` (back in about ${Math.ceil(err.retryAfterSeconds)}s)` : "";
    try {
      const result = await getGeminiReply({
        userId: params.userId,
        systemPrompt,
        message: params.message,
        history,
        droppedMessages,
        thinking: false,
      });
      return {
        ...result,
        provider: "gemini",
        providerNote: `Groq's limit was reached${retrySuffix}, so this reply came from Gemini instead.`,
      };
    } catch (geminiErr) {
      // Both providers failing in the same turn is rare (Gemini itself
      // transiently overloaded right when Groq needed backup), but dumping
      // that raw error into the chat isn't useful — a plain, honest message
      // beats a stack of JSON. Still worth logging why, same reasoning as
      // the mirrored catch above. Thrown (rather than returned as a normal
      // 200 reply) so the client's retry-button logic actually fires.
      console.error("Gemini backup also failed after Groq:", geminiErr);
      throw new Error(
        `Groq's limit was reached${retrySuffix}, and Gemini — its backup — is also temporarily unavailable right now. Please try again in a moment.`
      );
    }
  }
}

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_TRANSCRIPTION_MODEL = "whisper-large-v3-turbo";

interface GroqTranscriptionResponse {
  text: string;
}

export async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("Voice input requires GROQ_API_KEY to be set on the server.");
  }

  const buffer = Buffer.from(audioBase64, "base64");
  const extension = mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : "m4a";

  const form = new FormData();
  form.append("file", new Blob([buffer], { type: mimeType }), `audio.${extension}`);
  form.append("model", GROQ_TRANSCRIPTION_MODEL);

  const res = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Groq transcription failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as GroqTranscriptionResponse;
  return data.text;
}
