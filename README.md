# Jarvys

Personal assistant with one account that's shared across devices. This repo
contains the bones for a cross-platform (iOS + PC/web) client and a server
that owns your account and assistant settings, so anything you customize
(assistant name, instructions, preferences) shows up everywhere you sign in.

## Structure

- `server/` — Node.js + Express + SQLite backend. Owns accounts (email +
  password, JWT sessions) and per-account assistant settings. Also exposes a
  stub `/assistant/chat` endpoint to wire a real model into later.
- `app/` — Expo (React Native) client. One codebase that runs as an iOS app
  and as a web app (usable on any PC via the browser). Handles login/signup,
  a basic chat screen, and a settings screen that reads/writes the synced
  account settings.

## Running the server

```bash
cd server
cp .env.example .env   # edit JWT_SECRET before using this for real
npm install
npm run dev             # starts on http://localhost:4000
```

Data is stored in a local SQLite file (`server/data/jarvys.db` by default).

## Running the app

```bash
cd app
npm install
npm run web    # runs in the browser — this is your "PC" client
npm run ios    # runs in the iOS simulator (requires Xcode) or Expo Go
```

On first launch, the app asks for a **Server URL** along with your email and
password:

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

- `/assistant/chat` just echoes your message back — swap in a real model
  call there.
- No password reset, email verification, or refresh-token rotation yet.
- No push notifications, background tasks, or offline queueing.
- The server uses a local SQLite file, fine for one machine; move to a
  hosted Postgres (or similar) before running this for real across devices
  that aren't on the same LAN.
