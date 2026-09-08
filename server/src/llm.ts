const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

// Context window for the model above (Groq docs: console.groq.com/docs/models).
// Override with GROQ_CONTEXT_WINDOW if you change GROQ_MODEL to something else.
const CONTEXT_WINDOW_TOKENS = Number(process.env.GROQ_CONTEXT_WINDOW ?? 131072);

// Once the conversation we're about to send is estimated past this fraction of
// the context window, we drop the oldest turns before sending — a simple
// sliding-window "compression" so a long chat never hits a hard API error.
const COMPRESSION_THRESHOLD_RATIO = 0.75;

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

export interface ChatResult {
  reply: string;
  usage: ChatUsage | null;
  compressed: boolean;
  droppedMessages: number;
}

interface GroqChatResponse {
  choices: { message: { content: string } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
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
    };
  }

  const systemPrompt = [
    `You are ${params.assistantName}, a helpful personal assistant.`,
    "Reply in plain conversational text — no markdown (no **bold**, headers, or bullet lists with *dashes) since replies are shown as plain text and sometimes read aloud.",
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

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: "user", content: params.message },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Groq request failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as GroqChatResponse;
  const reply = data.choices[0]?.message.content ?? "(empty response from model)";
  const usage: ChatUsage | null = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
        contextWindow: CONTEXT_WINDOW_TOKENS,
      }
    : null;

  return { reply, usage, compressed: droppedMessages > 0, droppedMessages };
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
