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

export interface ChatResult {
  reply: string;
  usage: ChatUsage | null;
  compressed: boolean;
  droppedMessages: number;
  rateLimit: DailyRateLimit | null;
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

const TOOLS = [
  {
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
  },
];

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
}): Promise<ChatResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return {
      reply: `${params.assistantName}: I heard "${params.message}". (No model wired up yet — set GROQ_API_KEY to enable real replies.)`,
      usage: null,
      compressed: false,
      droppedMessages: 0,
      rateLimit: null,
    };
  }

  const systemPrompt = [
    `You are ${params.assistantName}, a helpful personal assistant.`,
    "Reply in plain conversational text — no markdown (no **bold**, headers, or bullet lists with *dashes) since replies are shown as plain text and sometimes read aloud.",
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

  const messages: GroqMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((turn): GroqMessage => ({ role: turn.role, content: turn.content })),
    { role: "user", content: params.message },
  ];

  let usageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let rateLimit: DailyRateLimit | null = null;

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
        tools: TOOLS,
        tool_choice: "auto",
        // Qwen3.6 defaults to an extended "thinking" mode that can burn
        // hundreds of output tokens on even a one-line reply — easily
        // enough to trip Groq's free-tier output-tokens-per-minute cap
        // (1,000/min) after just one or two messages. "none" is documented
        // as the mode for general-purpose dialogue; a personal assistant
        // chat doesn't need step-by-step reasoning shown. max_tokens keeps
        // a single reply from requesting more than that per-minute budget
        // on its own.
        reasoning_effort: "none",
        max_tokens: 800,
      }),
    });

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
      const reply = message?.content ?? "(empty response from model)";
      return { reply, usage, compressed: droppedMessages > 0, droppedMessages, rateLimit };
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
  };
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
