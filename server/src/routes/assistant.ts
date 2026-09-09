import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, saveMapPointsFromSearch, type AssistantSettingsRow, type ChatMessageRow } from "../db.js";
import { getAssistantReply, transcribeAudio, type MapData } from "../llm.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

// How much of the account's stored chat log to load per request. This bounds
// both what we send to getAssistantReply (which trims further based on
// estimated tokens) and what a client sees when it asks for history.
const MAX_HISTORY_MESSAGES = 200;

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

// Most recent MAX_HISTORY_MESSAGES rows, returned oldest-first.
async function getChatHistory(userId: string): Promise<ChatMessageRow[]> {
  const result = await db.execute({
    sql: `SELECT * FROM (
            SELECT rowid, * FROM chat_messages WHERE user_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT ?
          ) ORDER BY created_at ASC, rowid ASC`,
    args: [userId, MAX_HISTORY_MESSAGES],
  });
  return result.rows as unknown as ChatMessageRow[];
}

async function saveChatMessage(
  userId: string,
  role: "user" | "assistant",
  content: string,
  mapData?: MapData | null
) {
  await db.execute({
    sql: "INSERT INTO chat_messages (id, user_id, role, content, map_data_json) VALUES (?, ?, ?, ?, ?)",
    args: [randomUUID(), userId, role, content, mapData ? JSON.stringify(mapData) : null],
  });
}

// The assistant's own place/landmark searches double as a growing personal
// map — every result gets backed up as a point instead of vanishing once
// the chat scrolls past it. Distance/region lookups aren't real POIs, so
// those are left out.
async function backupMapData(userId: string, mapData: MapData | null) {
  if (!mapData || (mapData.kind !== "places" && mapData.kind !== "landmark")) return;
  await saveMapPointsFromSearch(
    userId,
    mapData.points.map((p) => ({
      name: p.label,
      category: p.category ?? "",
      subcategory: p.subcategory ?? "",
      icon: p.icon ?? "📍",
      lat: p.lat,
      lon: p.lon,
      urls: p.urls,
      blurb: p.blurb ?? p.address ?? "",
      source: mapData.kind === "landmark" ? "wikipedia" : "search",
    }))
  );
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

// The account's saved conversation, oldest first — loaded on app open so a
// refresh or a different device picks up where the last one left off.
assistantRouter.get("/messages", async (req: AuthedRequest, res) => {
  const rows = await getChatHistory(req.userId!);
  res.json({
    messages: rows.map((r) => ({
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
      mapData: r.map_data_json ? JSON.parse(r.map_data_json) : null,
    })),
  });
});

const chatSchema = z.object({
  message: z.string().min(1).max(4000),
  forceReasoningEffort: z.enum(["default", "none"]).optional(),
});

assistantRouter.post("/chat", async (req: AuthedRequest, res) => {
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "message is required" });
  }

  const row = await getSettingsRow(req.userId!);
  const historyRows = await getChatHistory(req.userId!);

  try {
    const result = await getAssistantReply({
      assistantName: row!.assistant_name,
      instructions: row!.instructions,
      message: parsed.data.message,
      history: historyRows.map((r) => ({ role: r.role, content: r.content })),
      forceReasoningEffort: parsed.data.forceReasoningEffort,
    });

    // A thinkingRequest means the model wants to ask before it answers —
    // nothing to save yet, since there's no real answer. The client
    // re-sends this same message with forceReasoningEffort once the user
    // picks yes/no, and that follow-up call is what actually gets saved.
    if (!result.thinkingRequest) {
      await saveChatMessage(req.userId!, "user", parsed.data.message);
      await saveChatMessage(req.userId!, "assistant", result.reply!, result.mapData);
      await backupMapData(req.userId!, result.mapData);
    }

    res.json(result);
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
