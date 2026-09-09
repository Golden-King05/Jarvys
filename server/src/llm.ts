import { convertCurrency } from "./currency.js";
import { calculateDistance, categoryIcon, findPlaces } from "./geo.js";
import { getGeminiReply, verifyRegionStatuses } from "./gemini.js";
import { extractRegionsFromText, findRegions, type RegionType } from "./regions.js";
import { getConditions } from "./weather.js";
import { searchWikipedia } from "./wikipedia.js";

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
  kind: "places" | "distance" | "landmark" | "regions";
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
  // Names of every tool actually called while producing this reply (e.g.
  // "search_wikipedia", "get_weather") — lets the client show a collapsed
  // "API used" marker instead of having the model narrate its own sourcing
  // in the reply text.
  toolsUsed: string[];
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

async function executeTool(call: ToolCall): Promise<{ result: unknown; mapData: MapData | null }> {
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

  return { result: { error: `Unknown tool: ${name}` }, mapData: null };
}

// No real tokenizer on hand server-side; a rough chars/4 estimate is only used
// to decide *before* sending whether to trim history. The actual usage
// numbers we report back come from Groq's response, not this estimate.
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function getAssistantReply(params: {
  assistantName: string;
  instructions: string;
  message: string;
  history: ChatTurn[];
  forceReasoningEffort?: "default" | "none";
}): Promise<ChatResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      reply: `${params.assistantName}: I heard "${params.message}". (No model wired up yet — set GROQ_API_KEY to enable real replies.)`,
      usage: null,
      compressed: false,
      droppedMessages: 0,
      rateLimit: null,
      thinkingRequest: null,
      provider: null,
      providerNote: null,
      mapData: null,
      toolsUsed: [],
    };
  }

  // When the model itself asked to think harder and the user answered yes/no,
  // the caller re-sends the same message with this set — skip the difficulty
  // check this time and just run at the chosen reasoning level.
  const offerThinkingTool = !params.forceReasoningEffort;
  const reasoningEffort = params.forceReasoningEffort ?? "none";

  const systemPrompt = [
    `You are ${params.assistantName}, a helpful personal assistant.`,
    "Reply in plain conversational text — no markdown (no **bold**, headers, tables, or bullet lists with *dashes) since replies are shown as plain text and sometimes read aloud.",
    "Give one direct, confident answer and stop — never think out loud, list multiple candidate answers, or write several paragraphs that each revise or contradict what you just said. Settle on your best answer before responding and state it once.",
    "You can look things up on Wikipedia with the search_wikipedia tool when a question needs a factual answer you're not confident about. Don't narrate that you used a tool or which source you checked — the app shows that separately, so just answer directly.",
    "Wikipedia's search matches keywords, not questions — searching the literal question text (e.g. 'oldest building in New York City') often returns an unrelated top result. Instead, identify the specific person/place/thing the question is most likely about from your own knowledge first, then search for that specific name to confirm and get details — never repeat the raw question as the search query.",
    "Only state facts the tool result actually contains — don't add extra specifics (an address, neighborhood, exact date, etc.) from your own memory that the result didn't confirm.",
    "You can find nearby restaurants, cafes, bars, or fast food with the find_places tool, and calculate the straight-line distance between two locations with the calculate_distance tool — results from either also appear on the user's map.",
    "When a factual answer from search_wikipedia is about a specific real-world place, it may also drop a pin on the user's map automatically.",
    "When the answer to a question is naturally a set of US states or countries (e.g. every state where something is legal), answer normally in text AND call highlight_regions with the full list so it also shades them on the map — you determine the list yourself, the tool only draws it.",
    "If the user asks to verify, double-check, reload, or fill in a states/countries map more exactly — including right after you or they just brought one up — call verify_map with the topic and regionType inferred from the conversation so far; it checks every region individually rather than a quick pass.",
    "You can check current weather with get_weather — it also drops a pin on the user's map. You can also convert between currencies with convert_currency using live exchange rates.",
    "You have no built-in way to know the real current date or time — never guess, compute, or state a specific current time or date on your own, even one that seems obviously derivable (e.g. from a timezone offset), since you can't verify it's actually correct right now. Always call get_local_time for any question about the current time, date, or day somewhere; it also drops a pin on the user's map.",
    params.instructions ? `Follow these instructions from your user: ${params.instructions}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  let history = params.history;
  let droppedMessages = 0;
  const threshold = CONTEXT_WINDOW_TOKENS * COMPRESSION_THRESHOLD_RATIO;

  function estimateTotal(h: ChatTurn[]): number {
    return (
      estimateTokens(systemPrompt) +
      estimateTokens(params.message) +
      h.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
    );
  }

  // Drop the oldest turns two at a time (a user/assistant pair) to keep the
  // remaining history alternating sensibly.
  while (history.length > 0 && estimateTotal(history) > threshold) {
    history = history.slice(2);
    droppedMessages += 2;
  }

  // The user already approved deep thinking (a prior call's checkDifficulty
  // returned a thinkingRequest and they clicked yes) — hand this one to
  // Gemini instead of Groq. See getGeminiReply for why.
  if (reasoningEffort === "default") {
    const result = await getGeminiReply({
      systemPrompt,
      message: params.message,
      history,
      droppedMessages,
      thinking: true,
    });
    return { ...result, provider: "gemini", providerNote: null };
  }

  try {
    // Ask a narrow yes/no question up front rather than hoping the model
    // interrupts its own answer to flag difficulty (see checkDifficulty).
    let usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let rateLimit: DailyRateLimit | null = null;
    let mapData: MapData | null = null;
    const toolsUsed = new Set<string>();

    if (offerThinkingTool) {
      const check = await checkDifficulty(apiKey, params.message);
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
          toolsUsed: [],
        };
      }
    }

    const messages: GroqMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map((turn): GroqMessage => ({ role: turn.role, content: turn.content })),
      { role: "user", content: params.message },
    ];

    const tools = [
      SEARCH_WIKIPEDIA_TOOL,
      FIND_PLACES_TOOL,
      CALCULATE_DISTANCE_TOOL,
      HIGHLIGHT_REGIONS_TOOL,
      VERIFY_MAP_TOOL,
      GET_WEATHER_TOOL,
      GET_LOCAL_TIME_TOOL,
      CONVERT_CURRENCY_TOOL,
    ];

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
          tools,
          tool_choice: "auto",
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

      if (res.status === 429) {
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

      const message = data.choices[0]?.message;
      const usage: ChatUsage | null =
        usageTotals.totalTokens > 0 ? { ...usageTotals, contextWindow: CONTEXT_WINDOW_TOKENS } : null;

      if (!message?.tool_calls || message.tool_calls.length === 0) {
        const reply = message?.content?.trim() ? message.content : "(empty response from model)";
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
          toolsUsed: [...toolsUsed],
        };
      }

      messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        toolsUsed.add(call.function.name);
        const { result, mapData: toolMapData } = await executeTool(call);
        if (toolMapData) mapData = toolMapData;
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
      toolsUsed: [...toolsUsed],
    };
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
    } catch {
      // Both providers failing in the same turn is rare (Gemini itself
      // transiently overloaded right when Groq needed backup), but dumping
      // that raw error into the chat isn't useful — a plain, honest message
      // beats a stack of JSON.
      return {
        reply: `Groq's limit was reached${retrySuffix}, and Gemini — its backup — is also temporarily unavailable right now. Please try again in a moment.`,
        usage: null,
        compressed: droppedMessages > 0,
        droppedMessages,
        rateLimit: null,
        thinkingRequest: null,
        provider: null,
        providerNote: null,
        mapData: null,
        toolsUsed: [],
      };
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
