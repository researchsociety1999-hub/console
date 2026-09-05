# Console

Console is a local-first, mobile-installable Progressive Web App (PWA) that acts as the command interface for the SGP Joker Card. It unifies proximity/NFC, Wi-Fi, BLE, GPIO, RGB, buzzer, and storage modules into a single 8-panel HUD, driven by a `lost -> ghost -> manifested` state machine and an Input -> Trust -> Context -> Action data firewall.

This repository ships as a **private** source repository. Treat all deployment URLs, API keys, and Supabase project details as sensitive.

## Contents

- `index.html` - application shell and HUD markup
- `manifest.webmanifest` - PWA install metadata
- `service-worker.js` - offline caching and lifecycle
- `css/tokens.css`, `css/app.css`, `css/states.css` - cinematic dark UI, responsive layout, and state visuals
- `js/state-machine.js` - lost/ghost/manifested lifecycle
- `js/data-firewall.js` - Input -> Trust -> Context -> Action pipeline
- `js/telemetry.js` - module data models (NFC, Wi-Fi, BLE, GPIO, RGB, buzzer)
- `js/joker-adapter.js` - hardware transport abstraction (simulated by default)
- `js/watchdog.js` - background health/alert loop
- `js/storage.js` - AES-256-GCM encrypted IndexedDB vault
- `js/agent.js` - client for the server-side AI proxy (never calls OpenRouter directly)
- `js/ui.js` - HUD rendering and console feed
- `js/app.js` - orchestration and event wiring
- `js/config.example.js` - copy to `js/config.js` (git-ignored) for local overrides
- `supabase/functions/console-agent/index.ts` - Supabase Edge Function template that proxies OpenRouter securely

## Running locally

Any static file server works, for example:

```bash
npx serve .
```

Then open the printed local URL in a browser and use "Add to Home Screen" (mobile) or the browser's install icon (desktop).

## Deploying

### GitHub Pages

1. Settings -> Pages -> Deploy from branch -> `main` / root.
2. Note that GitHub Pages serves static files only. If your account/plan does not support Pages on private repositories, use Vercel instead, or make the repo public knowing there are no secrets in it.

### Vercel

Import this repository as a static project (no build step required); root directory is the repo root.

## Cloud AI Agent (OpenRouter via Supabase)

The PWA never holds an OpenRouter API key. The Settings panel's Cloud Agent toggle is **off by default**. When enabled by the user, `js/agent.js` sends only an aggregated, redacted telemetry summary plus the user's question to a Supabase Edge Function, which holds `OPENROUTER_API_KEY` as a server secret and forwards a minimal, allow-listed request to OpenRouter.

Setup:

```bash
supabase functions deploy console-agent
supabase secrets set OPENROUTER_API_KEY="sk-or-v1-REPLACE"
supabase secrets set OPENROUTER_MODEL="provider/model-name"
supabase secrets set ALLOWED_ORIGIN="https://your-deployment-url"
```

Then set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `AGENT_FUNCTION_URL` in `js/config.js` (copied from `js/config.example.js`, which is git-ignored).

## Security notes

- No API keys, tokens, or secrets are stored in this repository.
- BadUSB/HID, GPIO, and RGB actions are simulated by default and require explicit user confirmation in the UI; the Joker adapter is the single extension point for real hardware transport.
- The local vault encrypts stored telemetry/history with AES-256-GCM, keyed by a passphrase-derived PBKDF2 key (100k iterations). Losing the passphrase means losing access to that data.
- Treat this app as a monitoring/diagnostic console for authorized use on hardware and networks you own or have explicit permission to test.
