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

authRouter.post("/register", (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
  }
  const { email, password } = parsed.data;

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (existing) {
    return res.status(409).json({ error: "An account with that email already exists" });
  }

  const id = randomUUID();
  db.prepare("INSERT INTO users (id, email, password_hash) VALUES (?, ?, ?)").run(
    id,
    email,
    hashPassword(password)
  );
  db.prepare("INSERT INTO assistant_settings (user_id) VALUES (?)").run(id);

  const token = signToken({ userId: id });
  res.status(201).json({ token, user: { id, email } });
});

authRouter.post("/login", (req, res) => {
  const parsed = credentialsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email or password" });
  }
  const { email, password } = parsed.data;

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as
    | UserRow
    | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken({ userId: user.id });
  res.json({ token, user: { id: user.id, email: user.email } });
});

authRouter.get("/me", requireAuth, (req: AuthedRequest, res) => {
  const user = db.prepare("SELECT id, email, created_at FROM users WHERE id = ?").get(
    req.userId
  );
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ user });
});
