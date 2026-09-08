import { Router } from "express";
import { z } from "zod";
import { db, type AssistantSettingsRow } from "../db.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const assistantRouter = Router();
assistantRouter.use(requireAuth);

function toApiSettings(row: AssistantSettingsRow) {
  return {
    assistantName: row.assistant_name,
    instructions: row.instructions,
    preferences: JSON.parse(row.preferences_json),
    updatedAt: row.updated_at,
  };
}

// GET the signed-in account's assistant settings. Any device that logs into
// the same account reads the same row here, which is what keeps
// personalization in sync across iOS and PC.
assistantRouter.get("/settings", (req: AuthedRequest, res) => {
  const row = db
    .prepare("SELECT * FROM assistant_settings WHERE user_id = ?")
    .get(req.userId) as AssistantSettingsRow | undefined;

  if (!row) {
    return res.status(404).json({ error: "Settings not found" });
  }
  res.json(toApiSettings(row));
});

const settingsSchema = z.object({
  assistantName: z.string().min(1).max(80).optional(),
  instructions: z.string().max(4000).optional(),
  preferences: z.record(z.unknown()).optional(),
});

assistantRouter.put("/settings", (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const current = db
    .prepare("SELECT * FROM assistant_settings WHERE user_id = ?")
    .get(req.userId) as AssistantSettingsRow | undefined;
  if (!current) {
    return res.status(404).json({ error: "Settings not found" });
  }

  const next = {
    assistant_name: parsed.data.assistantName ?? current.assistant_name,
    instructions: parsed.data.instructions ?? current.instructions,
    preferences_json: parsed.data.preferences
      ? JSON.stringify(parsed.data.preferences)
      : current.preferences_json,
  };

  db.prepare(
    `UPDATE assistant_settings
     SET assistant_name = ?, instructions = ?, preferences_json = ?, updated_at = datetime('now')
     WHERE user_id = ?`
  ).run(next.assistant_name, next.instructions, next.preferences_json, req.userId);

  const updated = db
    .prepare("SELECT * FROM assistant_settings WHERE user_id = ?")
    .get(req.userId) as AssistantSettingsRow;
  res.json(toApiSettings(updated));
});

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
});

// Placeholder reply endpoint: wire this up to a real model later. For now it
// echoes the message back so the client <-> server <-> account round trip
// (and per-account settings) can be exercised end to end.
assistantRouter.post("/chat", (req: AuthedRequest, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "message is required" });
  }

  const row = db
    .prepare("SELECT * FROM assistant_settings WHERE user_id = ?")
    .get(req.userId) as AssistantSettingsRow;

  res.json({
    reply: `${row.assistant_name}: I heard "${parsed.data.message}". (No model wired up yet.)`,
  });
});
