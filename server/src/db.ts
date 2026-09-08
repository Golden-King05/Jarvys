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
`);

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
