import type { ChatResult, ChatTurn, ChatUsage } from "./llm.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

// Approximate — Gemini's Flash family is generally documented around a
// 1M-token context window. Adjust via GEMINI_CONTEXT_WINDOW if that's off
// for whichever model this points at.
const GEMINI_CONTEXT_WINDOW_TOKENS = Number(process.env.GEMINI_CONTEXT_WINDOW ?? 1_000_000);

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

// Used only for the "yes, think it through" follow-through after the user
// approves deep thinking (see checkDifficulty in llm.ts). Groq's free tier
// caps a single reply around 900 output tokens total, reasoning included —
// not enough room for both extended reasoning and a full answer on a
// genuinely hard problem (confirmed: it came back empty on a logic puzzle).
// Gemini's free tier allows 250,000 tokens/minute, which is why the harder
// question gets routed here instead of retried on Groq with a bigger
// (unavailable) budget.
export async function getGeminiReply(params: {
  systemPrompt: string;
  message: string;
  history: ChatTurn[];
  droppedMessages: number;
}): Promise<ChatResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      reply:
        "Extended thinking needs a free Gemini API key configured as GEMINI_API_KEY on the server — Groq's free tier doesn't leave enough room for both deep reasoning and a full answer. Ask for a quick answer instead, or get a free key at aistudio.google.com and add it.",
      usage: null,
      compressed: params.droppedMessages > 0,
      droppedMessages: params.droppedMessages,
      rateLimit: null,
      thinkingRequest: null,
      provider: "gemini",
      providerNote: null,
    };
  }

  const contents = [
    ...params.history.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.content }],
    })),
    { role: "user", parts: [{ text: params.message }] },
  ];

  const res = await fetch(`${GEMINI_API_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: params.systemPrompt }] },
      generationConfig: { maxOutputTokens: 4096 },
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini request failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as GeminiResponse;
  const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "(empty response from Gemini)";
  const usage: ChatUsage | null = data.usageMetadata
    ? {
        promptTokens: data.usageMetadata.promptTokenCount ?? 0,
        completionTokens: data.usageMetadata.candidatesTokenCount ?? 0,
        totalTokens: data.usageMetadata.totalTokenCount ?? 0,
        contextWindow: GEMINI_CONTEXT_WINDOW_TOKENS,
      }
    : null;

  return {
    reply,
    usage,
    compressed: params.droppedMessages > 0,
    droppedMessages: params.droppedMessages,
    rateLimit: null,
    thinkingRequest: null,
    provider: "gemini",
    providerNote: null,
  };
}
