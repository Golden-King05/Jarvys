import { Router } from "express";
import { z } from "zod";
import { db, type AssistantSettingsRow } from "../db.js";
import { getAssistantReply, transcribeAudio } from "../llm.js";
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

async function getSettingsRow(userId: string) {
  const result = await db.execute({
    sql: "SELECT * FROM assistant_settings WHERE user_id = ?",
    args: [userId],
  });
  return result.rows[0] as unknown as AssistantSettingsRow | undefined;
}

// GET the signed-in account's assistant settings. Any device that logs into
// the same account reads the same row here, which is what keeps
// personalization in sync across iOS and PC.
assistantRouter.get("/settings", async (req: AuthedRequest, res) => {
  const row = await getSettingsRow(req.userId!);
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

assistantRouter.put("/settings", async (req: AuthedRequest, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }

  const current = await getSettingsRow(req.userId!);
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

  await db.execute({
    sql: `UPDATE assistant_settings
          SET assistant_name = ?, instructions = ?, preferences_json = ?, updated_at = datetime('now')
          WHERE user_id = ?`,
    args: [next.assistant_name, next.instructions, next.preferences_json, req.userId!],
  });

  const updated = await getSettingsRow(req.userId!);
  res.json(toApiSettings(updated!));
});

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
});

assistantRouter.post("/chat", async (req: AuthedRequest, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "message is required" });
  }

  const row = await getSettingsRow(req.userId!);
  try {
    const reply = await getAssistantReply({
      assistantName: row!.assistant_name,
      instructions: row!.instructions,
      message: parsed.data.message,
    });
    res.json({ reply });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Assistant request failed" });
  }
});

const transcribeSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().min(1),
});

assistantRouter.post("/transcribe", async (req: AuthedRequest, res) => {
  const parsed = transcribeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "audioBase64 and mimeType are required" });
  }

  try {
    const text = await transcribeAudio(parsed.data.audioBase64, parsed.data.mimeType);
    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Transcription failed" });
  }
});
