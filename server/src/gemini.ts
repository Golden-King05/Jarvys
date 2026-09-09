import { incrementProviderUsage } from "./db.js";
import { calculateDistance, categoryIcon, findPlaces } from "./geo.js";
import type { ChatResult, ChatTurn, ChatUsage, DailyRateLimit, MapData } from "./llm.js";
import { extractRegionsFromText, findRegions } from "./regions.js";
import { searchWikipedia } from "./wikipedia.js";

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

async function executeTool(call: GeminiFunctionCall): Promise<{ result: unknown; mapData: MapData | null }> {
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

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: params.systemPrompt }] },
        tools: [SEARCH_WIKIPEDIA_TOOL],
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
      };
    }

    contents.push({ role: "model", parts });
    const { result, mapData: toolMapData } = await executeTool(functionCallPart.functionCall);
    if (toolMapData) mapData = toolMapData;
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
  };
}
