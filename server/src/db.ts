import { createClient, type Client } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

// Local dev: a plain SQLite file (e.g. "file:./data/jarvys.db").
// Hosted: a Turso database URL ("libsql://...") + DATABASE_AUTH_TOKEN.
// Same client, same SQL, either way.
const url = process.env.DATABASE_URL ?? "file:./data/jarvys.db";

if (url.startsWith("file:")) {
  const filePath = url.slice("file:".length);
  fs.mkdirSync(path.dirname(filePath) || ".", { recursive: true });
}

export const db: Client = createClient({
  url,
  authToken: process.env.DATABASE_AUTH_TOKEN,
});

await db.executeMultiple(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assistant_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    assistant_name TEXT NOT NULL DEFAULT 'Jarvys',
    instructions TEXT NOT NULL DEFAULT '',
    preferences_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_user_created
    ON chat_messages(user_id, created_at);

  -- Gemini doesn't return remaining-quota headers the way Groq does, so we
  -- track our own call count per UTC day to show a comparable "X left
  -- today" figure once a conversation is running on Gemini.
  CREATE TABLE IF NOT EXISTS provider_usage (
    provider TEXT NOT NULL,
    usage_date TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, usage_date)
  );
`);

export async function incrementProviderUsage(provider: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  await db.execute({
    sql: `INSERT INTO provider_usage (provider, usage_date, count) VALUES (?, ?, 1)
          ON CONFLICT(provider, usage_date) DO UPDATE SET count = count + 1`,
    args: [provider, today],
  });
  const result = await db.execute({
    sql: "SELECT count FROM provider_usage WHERE provider = ? AND usage_date = ?",
    args: [provider, today],
  });
  return Number((result.rows[0] as unknown as { count: number } | undefined)?.count ?? 0);
}

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

export interface AssistantSettingsRow {
  user_id: string;
  assistant_name: string;
  instructions: string;
  preferences_json: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}
