import { getGeminiReply } from "./gemini.js";
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
}

class GroqRateLimitError extends Error {}

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
    throw new GroqRateLimitError(await res.text().catch(() => "Groq rate limit"));
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

async function executeTool(call: ToolCall): Promise<unknown> {
  if (call.function.name !== "search_wikipedia") {
    return { error: `Unknown tool: ${call.function.name}` };
  }
  let args: { query?: string };
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    return { error: "Could not parse tool arguments" };
  }
  if (!args.query) {
    return { error: "Missing required 'query' argument" };
  }
  return searchWikipedia(args.query);
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
    "You can look things up on Wikipedia with the search_wikipedia tool when a question needs a factual answer you're not confident about — mention naturally that you checked Wikipedia when you use it.",
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
    const result = await getGeminiReply({ systemPrompt, message: params.message, history, droppedMessages });
    return { ...result, provider: "gemini", providerNote: null };
  }

  try {
    // Ask a narrow yes/no question up front rather than hoping the model
    // interrupts its own answer to flag difficulty (see checkDifficulty).
    let usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let rateLimit: DailyRateLimit | null = null;

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
        };
      }
    }

    const messages: GroqMessage[] = [
      { role: "system", content: systemPrompt },
      ...history.map((turn): GroqMessage => ({ role: turn.role, content: turn.content })),
      { role: "user", content: params.message },
    ];

    const tools = [SEARCH_WIKIPEDIA_TOOL];

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
        throw new GroqRateLimitError(await res.text().catch(() => "Groq rate limit"));
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
        };
      }

      messages.push({ role: "assistant", content: message.content, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        const result = await executeTool(call);
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
    };
  } catch (err) {
    if (!(err instanceof GroqRateLimitError)) {
      throw err;
    }
    // Groq is out of capacity for now (daily or per-minute) — Gemini picks
    // up this turn instead of failing the message outright. It gets the
    // same trimmed history, so the conversation continues without a gap.
    const result = await getGeminiReply({ systemPrompt, message: params.message, history, droppedMessages });
    return {
      ...result,
      provider: "gemini",
      providerNote: "Groq's limit was reached, so this reply came from Gemini instead.",
    };
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
