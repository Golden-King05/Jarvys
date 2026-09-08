const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile";

interface GroqChatResponse {
  choices: { message: { content: string } }[];
}

export async function getAssistantReply(params: {
  assistantName: string;
  instructions: string;
  message: string;
}): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return `${params.assistantName}: I heard "${params.message}". (No model wired up yet — set GROQ_API_KEY to enable real replies.)`;
  }

  const systemPrompt = [
    `You are ${params.assistantName}, a helpful personal assistant.`,
    params.instructions ? `Follow these instructions from your user: ${params.instructions}` : null,
  ]
    .filter(Boolean)
    .join(" ");

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
        { role: "user", content: params.message },
      ],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Groq request failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as GroqChatResponse;
  return data.choices[0]?.message.content ?? "(empty response from model)";
}
