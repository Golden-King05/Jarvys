export class ApiError extends Error {}

export interface AssistantSettings {
  assistantName: string;
  instructions: string;
  preferences: Record<string, unknown>;
  updatedAt: string;
}

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

export interface ChatResponse {
  reply: string;
  usage: ChatUsage | null;
  compressed: boolean;
  droppedMessages: number;
}

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

  getSettings: (baseUrl: string, token: string) =>
    request<AssistantSettings>(baseUrl, "/assistant/settings", { token }),

  updateSettings: (baseUrl: string, token: string, patch: Partial<AssistantSettings>) =>
    request<AssistantSettings>(baseUrl, "/assistant/settings", {
      method: "PUT",
      token,
      body: patch,
    }),

  chat: (baseUrl: string, token: string, message: string, history: ChatTurn[]) =>
    request<ChatResponse>(baseUrl, "/assistant/chat", {
      method: "POST",
      token,
      body: { message, history },
    }),

  transcribe: (baseUrl: string, token: string, audioBase64: string, mimeType: string) =>
    request<{ text: string }>(baseUrl, "/assistant/transcribe", {
      method: "POST",
      token,
      body: { audioBase64, mimeType },
    }),
};
