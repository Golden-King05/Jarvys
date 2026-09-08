import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, type UserRow } from "../db.js";
import { hashPassword, signToken, verifyPassword } from "../auth.js";
import { requireAuth, type AuthedRequest } from "../middleware/auth.js";

export const authRouter = Router();

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

authRouter.post("/register", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { email, password } = parsed.data;

  const existing = await db.execute({
    sql: "SELECT id FROM users WHERE email = ?",
    args: [email],
  });
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const id = randomUUID();
  await db.execute({
    sql: "INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)",
    args: [id, email, hashPassword(password)],
  });
  await db.execute({
    sql: "INSERT INTO assistant_settings (user_id) VALUES (?)",
    args: [id],
  });

  const token = signToken({ userId: id });
  res.status(201).json({ token, user: { id, email } });
});

authRouter.post("/login", async (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password" });
  }
  const { email, password } = parsed.data;

  const result = await db.execute({
    sql: "SELECT * FROM users WHERE email = ?",
    args: [email],
  });
  const user = result.rows[0] as unknown as UserRow | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken({ userId: user.id });
  res.json({ token, user: { id: user.id, email: user.email } });
});

authRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const result = await db.execute({
    sql: "SELECT id, email, created_at FROM users WHERE id = ?",
    args: [req.userId!],
  });
  const user = result.rows[0];
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ user });
});
