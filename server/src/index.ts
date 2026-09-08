import "dotenv/config";
import cors from "cors";
import express from "express";
import { authRouter } from "./routes/auth.js";
import { assistantRouter } from "./routes/assistant.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/assistant", assistantRouter);

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Jarvys server listening on port ${port}`);
});
