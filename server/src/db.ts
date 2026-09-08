import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_PATH ?? "./data/jarvys.db";
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
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
