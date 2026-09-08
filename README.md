# Jarvys

Personal assistant with one account that's shared across devices. This repo
contains the bones for a cross-platform (iOS + PC/web) client and a server
that owns your account and assistant settings, so anything you customize
(assistant name, instructions, preferences) shows up everywhere you sign in.

## Structure

- `server/` — Node.js + Express backend, using SQLite (via `@libsql/client`,
  which works against a local file for dev and a hosted Turso database in
  production with no code changes). Owns accounts (email + password, JWT
  sessions) and per-account assistant settings. `/assistant/chat` calls an
  open-source model on Groq's free tier when `GROQ_API_KEY` is set, and
  falls back to echoing your message when it isn't.
- `app/` — Expo (React Native) client. One codebase that runs as an iOS app
  and as a web app (usable on any PC via the browser). Handles login/signup,
  a chat screen (type or talk to it, replies can be spoken back), and a
  settings screen that reads/writes the synced account settings.

## Running the server

```bash
cd server
cp .env.example .env   # edit JWT_SECRET before using this for real
npm install
npm run dev             # starts on http://localhost:4000
```

Data is stored in a local SQLite file (`server/data/jarvys.db` by default).

## Hosting it for real (free)

Running the server on your own machine only works for devices on the same
network. To make it reachable from your iPhone and PC anywhere, host it on:

- **[Render](https://render.com)** (free web hosting) for the server itself.
- **[Turso](https://turso.tech)** (free, persistent SQLite-compatible
  database) for storage — Render's free tier doesn't keep a local file
  around between restarts, so the database needs to live somewhere durable.

Both are free with no credit card. Steps:

1. **Create the database:**
   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash   # installs the Turso CLI
   turso auth login                                   # opens a browser to sign up/in
   turso db create jarvys
   turso db show jarvys --url                         # copy this -> DATABASE_URL
   turso db tokens create jarvys                       # copy this -> DATABASE_AUTH_TOKEN
   ```
2. **Deploy the server on Render:**
   - Push this repo to GitHub (already done if you're reading this from the
     repo).
   - In the Render dashboard: New → Blueprint → pick this repo. Render reads
     `render.yaml` at the repo root and configures the `server/` service
     automatically.
   - When prompted, set the environment variables it asks for:
     - `JWT_SECRET` — any long random string.
     - `DATABASE_URL` — the `libsql://...` URL from step 1.
     - `DATABASE_AUTH_TOKEN` — the token from step 1.
   - Deploy. Render gives you a public URL like
     `https://jarvys-server.onrender.com`.

Note: Render's free tier spins the server down after inactivity, so the
first request after a quiet period takes ~30–50 seconds to wake back up —
normal, not a bug.

## Giving it a real brain (free)

By default `/assistant/chat` just echoes your message back. To make it
actually respond, get a free API key from **[Groq](https://groq.com)**
(no credit card, generous rate limits, and it serves current open-weight
models like Llama 3.3 70B on very fast hardware):

1. Sign up at console.groq.com and create an API key.
2. Add it as an environment variable:
   - Local dev: put `GROQ_API_KEY=...` in `server/.env`.
   - Hosted on Render: add `GROQ_API_KEY` in the service's Environment tab.
3. That's it — `/assistant/chat` will start sending your message (plus your
   assistant name and instructions from Settings as a system prompt) to
   Groq and returning the real reply.

`GROQ_MODEL` is optional if you want to try a different model than the
default (`llama-3.3-70b-versatile`) — see console.groq.com for the current
list of hosted models.

## Talking to it instead of typing

The same `GROQ_API_KEY` also powers voice: tap **Talk** on the chat screen,
say something, tap **Stop** — the app records the clip, sends it to
`/assistant/transcribe` (Groq's Whisper model, same free tier, no extra
setup), and sends the transcribed text as your message automatically.
Replies are spoken back out loud by default; tap **Mute replies** to turn
that off. No extra account or key needed beyond the Groq one above.

Voice input uses the device microphone (`expo-av`) and on-device text-to-
speech (`expo-speech` on iOS, the browser's built-in speech synthesis on
web) — nothing else to install. The first time you tap Talk, iOS/the
browser will ask for microphone permission.

## Running the app

```bash
cd app
npm install
npm run web    # runs in the browser — this is your "PC" client
npm run ios    # runs in the iOS simulator (requires Xcode) or Expo Go
```

Easiest way to see it on an actual iPhone without Xcode: install the free
**Expo Go** app from the App Store, run `npm run start` (or `npm run ios`)
from `app/`, and scan the QR code it prints with your phone's camera.

On first launch, the app asks for a **Server URL** along with your email and
password. Once the server is deployed (see "Hosting it for real" above),
enter its public Render URL (e.g. `https://jarvys-server.onrender.com`) on
both the web build and the iOS build — that's what makes it reachable from
your PC and iPhone regardless of what network either one is on.

Before it's deployed, for local testing only:
- On web, `http://localhost:4000` works if the server is running on the same
  machine.
- On a physical iOS device, `localhost` refers to the phone, not your
  computer — use your computer's LAN IP instead (e.g. `http://192.168.1.20:4000`),
  and make sure the phone and server are on the same network.

Create an account once from either platform, then log into the same account
from the other — your assistant name/instructions saved in Settings will be
there on both, since they're stored server-side against your account rather
than on the device.

## How the account sync works

- The server hashes passwords (bcrypt) and issues a JWT on login/register.
- The app stores that JWT locally (`AsyncStorage`) and sends it as a Bearer
  token on every request.
- Assistant settings live in one `assistant_settings` row per account in the
  server's database — every device authenticated as that account reads and
  writes the same row, which is what keeps things in sync.

## What's stubbed / not built yet

- No password reset, email verification, or refresh-token rotation yet.
- No push notifications, background tasks, or offline queueing.
