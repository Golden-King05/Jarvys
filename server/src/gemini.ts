import { getAirQuality } from "./airquality.js";
import { convertCurrency } from "./currency.js";
import { findMapPointsByName, findMapPointsByTag, getDistinctTagKeys, incrementProviderUsage, type PointTag } from "./db.js";
import { flightToMapPoint, getFlightsInBoundingBox } from "./flights.js";
import { calculateDistance, categoryIcon, findPlaces, geocode, geocodeArea } from "./geo.js";
import type { ChatResult, ChatTurn, ChatUsage, DailyRateLimit, LayerCommand, MapData } from "./llm.js";
import { getActiveAlerts, getNwsForecast } from "./nws.js";
import { extractRegionsFromText, findRegions, getAllRegions, type RegionType } from "./regions.js";
import { getConditions, getForecast } from "./weather.js";
import { searchWeb } from "./websearch.js";
import { findArticlesInArea, getWikipediaByTitle, searchWikipedia, wikipediaTitleFromUrl } from "./wikipedia.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

// Approximate — Gemini's Flash family is generally documented around a
// 1M-token context window. Adjust via GEMINI_CONTEXT_WINDOW if that's off
// for whichever model this points at.
const GEMINI_CONTEXT_WINDOW_TOKENS = Number(process.env.GEMINI_CONTEXT_WINDOW ?? 1_000_000);

// Gemini's free tier for Flash models (console docs, checked directly
// against the current pricing/rate-limit page) — 1,500 requests/day.
// Override via GEMINI_DAILY_LIMIT if you point this at a different model.
const GEMINI_DAILY_LIMIT = Number(process.env.GEMINI_DAILY_LIMIT ?? 1500);

const MAX_TOOL_ITERATIONS = 4;

const SEARCH_WIKIPEDIA_TOOL = {
  functionDeclarations: [
    {
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
    {
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
    {
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
    {
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
    {
      name: "highlight_regions",
      description:
        "Shade a set of US states or countries on the user's map. You decide which regions match the question yourself (e.g. every US state where something is legal) — this tool only draws the ones you list, so pass every matching region's full common name, not an abbreviation. Use it whenever an answer is naturally a set of states or countries rather than a single place.",
      parameters: {
        type: "object",
        properties: {
          regionType: {
            type: "string",
            enum: ["us_state", "country"],
            description: "What kind of regions these are.",
          },
          names: {
            type: "array",
            items: { type: "string" },
            description: 'Full names of every matching region, e.g. ["Ohio", "Michigan"].',
          },
        },
        required: ["regionType", "names"],
      },
    },
    {
      name: "verify_map",
      description:
        "Go through every US state or country one at a time and double-check its status on a topic already discussed, instead of relying on a quick first-pass answer. Call this when the user asks to verify, double-check, reload, or fill in the map more exactly or completely. Infer the topic and regionType from the conversation so far.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "The specific topic being checked, e.g. 'owning a raccoon as a pet'.",
          },
          regionType: {
            type: "string",
            enum: ["us_state", "country"],
            description: "Which kind of regions to check.",
          },
        },
        required: ["topic", "regionType"],
      },
    },
    {
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
    {
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
    {
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
    {
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
    {
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
    {
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
    {
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
    {
      name: "list_saved_tag_keys",
      description:
        "List every tag header already used across the user's saved points (e.g. 'architecture', 'start_date'). Call this before tagging a point with propose_map_point so you reuse an existing header instead of inventing a near-duplicate — nothing enforces this, so checking first is the only way headers stay consistent.",
      parameters: { type: "object", properties: {} },
    },
    {
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
    {
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
    {
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
    {
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
    {
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
    {
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
  ],
};

interface GeminiFunctionCall {
  name: string;
  args?: Record<string, unknown>;
  id?: string;
}

interface GeminiFunctionResponse {
  name: string;
  id?: string;
  response: unknown;
}

interface GeminiPart {
  text?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
}

interface GeminiResponse {
  candidates?: { content?: { role?: string; parts?: GeminiPart[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fenced ? fenced[1] : text;
}

// The heuristic text-scan (extractRegionsFromText) is a best-effort guess
// from prose, and it only knows about the states/countries the reply
// happened to mention — everything else defaults to red. This is the
// deliberate, exhaustive alternative: a dedicated call that goes state by
// state (or country by country) and classifies every single one, always on
// Gemini regardless of which provider is answering normally, since the
// output is comfortably bigger than Groq's free-tier reply ceiling allows.
export async function verifyRegionStatuses(
  topic: string,
  regionType: RegionType
): Promise<{ mapData: MapData } | { error: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      error:
        "A full state-by-state check needs a free Gemini API key configured as GEMINI_API_KEY on the server.",
    };
  }

  const allRegions = getAllRegions(regionType);
  const label = regionType === "us_state" ? "US state (plus DC and Puerto Rico)" : "country";
  const prompt = [
    `Topic: "${topic}"`,
    `For every ${label} listed below, decide its status regarding this topic:`,
    '"green" if it is fully allowed/legal, "yellow" if it is allowed only with a permit, license, registration, or other restriction, or "red" if it is not allowed, illegal, or the topic does not apply there.',
    `Regions: ${allRegions.map((r) => r.name).join(", ")}`,
    'Respond with ONLY a JSON object mapping each region\'s exact name to "green", "yellow", or "red". Include every region listed. No other text.',
  ].join("\n\n");

  const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 8192,
        thinkingConfig: { thinkingLevel: "low" },
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return { error: `Verification request failed (${res.status}): ${detail}` };
  }

  const data = (await res.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.find((p) => typeof p.text === "string")?.text;
  if (!text) {
    return { error: "Gemini didn't return a usable verification result." };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return { error: "Couldn't parse the verification result." };
  }

  const normalized = new Map<string, unknown>();
  for (const [name, status] of Object.entries(parsed)) {
    normalized.set(name.toLowerCase(), status);
  }

  const regions: MapData["regions"] = allRegions.map((r) => {
    const status = normalized.get(r.name.toLowerCase());
    return {
      name: r.name,
      geometry: r.geometry,
      status: status === "green" || status === "yellow" || status === "red" ? status : "red",
    };
  });

  return { mapData: { kind: "regions", points: [], regionType, regions, verified: true } };
}

// See the identical helper in llm.ts for why this exists — a plain "call
// the tool" instruction wasn't reliable enough on its own, so forecast-
// shaped messages force the tool call on the first turn instead.
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
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as any).key === "string" &&
      typeof (entry as any).value === "string"
    ) {
      tags.push({ key: (entry as any).key, value: (entry as any).value });
    }
  }
  return tags;
}

async function executeTool(
  call: GeminiFunctionCall,
  userId: string
): Promise<{ result: unknown; mapData: MapData | null; layerCommand?: LayerCommand | null }> {
  const args = call.args ?? {};

  if (call.name === "search_wikipedia") {
    const query = args.query;
    if (typeof query !== "string" || !query) {
      return { result: { error: "Missing required 'query' argument" }, mapData: null };
    }
    const result = await searchWikipedia(query);
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

  if (call.name === "search_web") {
    const query = args.query;
    if (typeof query !== "string" || !query) {
      return { result: { error: "Missing required 'query' argument" }, mapData: null };
    }
    const result = await searchWeb(query);
    return { result, mapData: null };
  }

  if (call.name === "get_wikipedia_article") {
    const urlOrTitle = args.urlOrTitle;
    if (typeof urlOrTitle !== "string" || !urlOrTitle) {
      return { result: { error: "Missing required 'urlOrTitle' argument" }, mapData: null };
    }
    const title = wikipediaTitleFromUrl(urlOrTitle) ?? urlOrTitle;
    const result = await getWikipediaByTitle(title);
    return { result, mapData: null };
  }

  if (call.name === "find_places") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const category = typeof args.category === "string" && args.category ? args.category : "restaurant";
    const result = await findPlaces(location, category);
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

  if (call.name === "calculate_distance") {
    const from = args.from;
    const to = args.to;
    if (typeof from !== "string" || !from || typeof to !== "string" || !to) {
      return { result: { error: "Missing required 'from'/'to' arguments" }, mapData: null };
    }
    const result = await calculateDistance(from, to);
    if ("error" in result) return { result, mapData: null };
    return {
      result,
      mapData: {
        kind: "distance",
        points: [
          { label: from, lat: result.from.lat, lon: result.from.lon },
          { label: to, lat: result.to.lat, lon: result.to.lon },
        ],
        distanceMiles: result.distanceMiles,
        distanceKm: result.distanceKm,
      },
    };
  }

  if (call.name === "highlight_regions") {
    const regionType = args.regionType;
    const names = args.names;
    if (regionType !== "us_state" && regionType !== "country") {
      return { result: { error: "regionType must be 'us_state' or 'country'" }, mapData: null };
    }
    if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) {
      return { result: { error: "Missing required 'names' array" }, mapData: null };
    }
    const matches = findRegions(regionType, names as string[]);
    if ("error" in matches) return { result: matches, mapData: null };
    return {
      result: { matched: matches.map((m) => m.name) },
      mapData: { kind: "regions", points: [], regionType, regions: matches },
    };
  }

  if (call.name === "verify_map") {
    const topic = args.topic;
    const regionType = args.regionType;
    if (typeof topic !== "string" || !topic) {
      return { result: { error: "Missing required 'topic' argument" }, mapData: null };
    }
    if (regionType !== "us_state" && regionType !== "country") {
      return { result: { error: "regionType must be 'us_state' or 'country'" }, mapData: null };
    }
    const verified = await verifyRegionStatuses(topic, regionType);
    if ("error" in verified) return { result: verified, mapData: null };
    return { result: { verified: true }, mapData: verified.mapData };
  }

  if (call.name === "get_weather") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getConditions(location);
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

  if (call.name === "get_weather_forecast") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const days = typeof args.days === "number" ? args.days : 5;

    // NWS's forecast is higher quality (detailed prose, twice-daily periods)
    // but only covers the US — try it first and quietly fall back to
    // Open-Meteo (worldwide) when the location is outside its coverage.
    const nws = await getNwsForecast(location, days * 2);
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

    const result = await getForecast(location, days);
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

  if (call.name === "get_weather_alerts") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getActiveAlerts(location);
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

  if (call.name === "get_air_quality") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getAirQuality(location);
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

  if (call.name === "find_flights_near") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const center = await geocode(location);
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

  if (call.name === "set_map_layer") {
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

  if (call.name === "get_local_time") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const result = await getConditions(location);
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

  if (call.name === "convert_currency") {
    const amount = args.amount;
    const from = args.from;
    const to = args.to;
    if (typeof amount !== "number" || typeof from !== "string" || typeof to !== "string") {
      return { result: { error: "Missing required 'amount'/'from'/'to' arguments" }, mapData: null };
    }
    return { result: await convertCurrency(amount, from, to), mapData: null };
  }

  if (call.name === "propose_map_point") {
    const name = args.name;
    const location = args.location;
    const description = args.description;
    if (typeof name !== "string" || !name || typeof location !== "string" || !location || typeof description !== "string" || !description) {
      return { result: { error: "Missing required 'name'/'location'/'description' arguments" }, mapData: null };
    }
    const geo = await geocode(location);
    if ("error" in geo) return { result: geo, mapData: null };
    return {
      result: { name, lat: geo.lat, lon: geo.lon },
      mapData: {
        kind: "point_suggestion",
        points: [
          {
            label: name,
            lat: geo.lat,
            lon: geo.lon,
            icon: typeof args.icon === "string" && args.icon ? args.icon : "📍",
            category: typeof args.category === "string" ? args.category : "",
            subcategory: typeof args.subcategory === "string" ? args.subcategory : undefined,
            blurb: description,
            tags: parseTagsArg(args.tags),
          },
        ],
      },
    };
  }

  if (call.name === "find_saved_point") {
    const query = args.query;
    if (typeof query !== "string" || !query) {
      return { result: { error: "Missing required 'query' argument" }, mapData: null };
    }
    const rows = await findMapPointsByName(userId, query);
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

  if (call.name === "list_saved_tag_keys") {
    return { result: { keys: await getDistinctTagKeys(userId) }, mapData: null };
  }

  if (call.name === "find_points_by_tag") {
    const key = args.key;
    if (typeof key !== "string" || !key) {
      return { result: { error: "Missing required 'key' argument" }, mapData: null };
    }
    const value = typeof args.value === "string" ? args.value : undefined;
    const rows = await findMapPointsByTag(userId, key, value);
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

  if (call.name === "find_wikipedia_articles_in_area") {
    const location = args.location;
    if (typeof location !== "string" || !location) {
      return { result: { error: "Missing required 'location' argument" }, mapData: null };
    }
    const area = await geocodeArea(location);
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

  return { result: { error: `Unknown tool: ${call.name}` }, mapData: null };
}

async function geminiDailyRateLimit(): Promise<DailyRateLimit> {
  const used = await incrementProviderUsage("gemini");
  return { limitRequests: GEMINI_DAILY_LIMIT, remainingRequests: Math.max(0, GEMINI_DAILY_LIMIT - used) };
}

// Handles two cases: the user approved "think it through" after
// checkDifficulty flagged a hard question (see llm.ts), and an automatic
// failover when Groq itself is out of capacity. Groq's free tier caps a
// single reply around 900 output tokens total, reasoning included — not
// enough room for both extended reasoning and a full answer on a genuinely
// hard problem (confirmed: it came back empty on a logic puzzle). Gemini's
// free tier allows 250,000 tokens/minute, which is why harder questions and
// Groq overflow both land here instead of retrying Groq with a budget that
// was never going to be enough.
export async function getGeminiReply(params: {
  userId: string;
  systemPrompt: string;
  message: string;
  history: ChatTurn[];
  droppedMessages: number;
  thinking: boolean;
}): Promise<ChatResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      reply:
        "This needs a free Gemini API key configured as GEMINI_API_KEY on the server. Get one at aistudio.google.com and add it.",
      usage: null,
      compressed: params.droppedMessages > 0,
      droppedMessages: params.droppedMessages,
      rateLimit: null,
      thinkingRequest: null,
      provider: "gemini",
      providerNote: null,
      mapData: null,
      layerCommand: null,
      toolsUsed: [],
    };
  }

  const contents: { role: string; parts: GeminiPart[] }[] = [
    ...params.history.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.content }],
    })),
    { role: "user", parts: [{ text: params.message }] },
  ];

  let usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let mapData: MapData | null = null;
  let layerCommand: LayerCommand | null = null;
  const toolsUsed = new Set<string>();
  const forceForecastTool = looksLikeForecastRequest(params.message);

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        tools: [SEARCH_WIKIPEDIA_TOOL],
        ...(iteration === 0 && forceForecastTool
          ? { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["get_weather_forecast"] } } }
          : {}),
        generationConfig: {
          maxOutputTokens: 4096,
          // gemini-3.x uses thinkingLevel (not the older thinkingBudget,
          // which is a Gemini 2.5-only field) — "high" for an approved deep-
          // thinking request or a Groq failover on a message that may itself
          // have been hard; "low" keeps an ordinary failover reply quick
          // rather than spending extra time reasoning about small talk.
          thinkingConfig: { thinkingLevel: params.thinking ? "high" : "low" },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Gemini request failed (${res.status}): ${detail}`);
    }

    const data = (await res.json()) as GeminiResponse;
    if (data.usageMetadata) {
      usageTotals = {
        promptTokens: usageTotals.promptTokens + (data.usageMetadata.promptTokenCount ?? 0),
        completionTokens: usageTotals.completionTokens + (data.usageMetadata.candidatesTokenCount ?? 0),
        totalTokens: usageTotals.totalTokens + (data.usageMetadata.totalTokenCount ?? 0),
      };
    }

    const parts = data.candidates?.[0]?.content?.parts ?? [];
    const functionCallPart = parts.find((p) => p.functionCall);
    const usage: ChatUsage | null =
      usageTotals.totalTokens > 0 ? { ...usageTotals, contextWindow: GEMINI_CONTEXT_WINDOW_TOKENS } : null;

    if (!functionCallPart?.functionCall) {
      const text = parts.find((p) => typeof p.text === "string")?.text;
      const reply = text?.trim() ? text : "(empty response from Gemini)";
      if (!mapData) {
        const found = extractRegionsFromText(reply);
        if (found) mapData = { kind: "regions", points: [], regionType: found.regionType, regions: found.regions };
      }
      return {
        reply,
        usage,
        compressed: params.droppedMessages > 0,
        droppedMessages: params.droppedMessages,
        rateLimit: await geminiDailyRateLimit(),
        thinkingRequest: null,
        provider: "gemini",
        providerNote: null,
        mapData,
        layerCommand,
        toolsUsed: [...toolsUsed],
      };
    }

    contents.push({ role: "model", parts });
    toolsUsed.add(functionCallPart.functionCall.name);
    const {
      result,
      mapData: toolMapData,
      layerCommand: toolLayerCommand,
    } = await executeTool(functionCallPart.functionCall, params.userId);
    if (toolMapData) mapData = toolMapData;
    if (toolLayerCommand) layerCommand = toolLayerCommand;
    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: functionCallPart.functionCall.name,
            ...(functionCallPart.functionCall.id ? { id: functionCallPart.functionCall.id } : {}),
            response: result,
          },
        },
      ],
    });
  }

  return {
    reply: "I was looking into that but couldn't wrap it up — could you try asking again?",
    usage: usageTotals.totalTokens > 0 ? { ...usageTotals, contextWindow: GEMINI_CONTEXT_WINDOW_TOKENS } : null,
    compressed: params.droppedMessages > 0,
    droppedMessages: params.droppedMessages,
    rateLimit: await geminiDailyRateLimit(),
    thinkingRequest: null,
    provider: "gemini",
    providerNote: null,
    mapData,
    layerCommand,
    toolsUsed: [...toolsUsed],
  };
}
