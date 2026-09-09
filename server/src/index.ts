import "dotenv/config";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { authRouter } from "./routes/auth.js";
import { assistantRouter } from "./routes/assistant.js";
import { flightsRouter } from "./routes/flights.js";
import { pointsRouter } from "./routes/points.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" })); // room for base64-encoded voice clips

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use("/auth", authRouter);
app.use("/assistant", assistantRouter);
app.use("/points", pointsRouter);
app.use("/flights", flightsRouter);

// Last-resort net: any route error that reaches here (typically forwarded by
// asyncHandler) gets a clean response instead of an unhandled exception.
// Must be registered after every other app.use()/route — Express only
// treats a 4-argument handler as error middleware.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled route error:", err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Something went wrong on the server. Please try again." });
});

// Pure insurance against a spot this doesn't cover (a rejection from
// somewhere outside a request, e.g. a stray unawaited promise) — confirmed
// in production that an uncaught one here otherwise crashes the entire
// process (and everyone's requests with it), not just the request that
// triggered it. Log loudly and keep serving rather than go down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection (server kept running):", reason);
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Jarvys server listening on port ${port}`);
});
