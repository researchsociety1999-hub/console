# Console

Console is a local-first, mobile-installable Progressive Web App (PWA) that acts as the command interface for the SGP Joker Card. It unifies proximity/NFC, Wi-Fi, BLE, GPIO, RGB, buzzer, and storage modules into a single 8-panel HUD, driven by a `lost -> ghost -> manifested` state machine and an Input -> Trust -> Context -> Action data firewall.

This repository ships as a **private** source repository. Treat all deployment URLs, API keys, and Supabase project details as sensitive.

## What's implemented

- Full 8-panel HUD: System Intelligence, Proximity Radar/NFC, Signals/Mesh Topology, Watchdog/Active Assessment, Command Surface, Module Launcher, Module Detail, Console/Trusted Event Feed.
- 10-module launcher (NFC, WiFi, BLE, BadUSB, GPIO, RGB, Buzzer, Storage, Console, Settings), each with a live **Module Detail** panel: rescan environment, confirmation-gated BadUSB presets, GPIO pin toggles, RGB effect selection, a Web-Audio buzzer test tone, and vault status.
- `lost -> ghost -> manifested` state machine with a dimmed, essential-only Ghost Protocol UI.
- Input -> Trust -> Context -> Action data firewall producing bounded `AlertData` objects.
- Background Watchdog loop with deduplicated, severity-based alerts, an audible Web Audio buzzer (gated by a Settings toggle), and automatic encrypted vault logging when unlocked.
- AES-256-GCM encrypted local vault (IndexedDB + PBKDF2), with Settings-panel unlock, an Export Intel button that decrypts and downloads a JSON file, and a Clear Vault action.
- Session persistence: the console log and last-known telemetry/settings survive a page refresh via `sessionStorage` and clear when the tab closes.
- **Local Model** tab: runs a GGUF LLM entirely in the browser via WebAssembly (wllama/llama.cpp) with zero API key, backend, or account. Curated small models plus arbitrary Hugging Face repo/file input. Once loaded, it is the default "Ask Agent" intelligence source.
- Optional Cloud Agent (OpenRouter via a Supabase Edge Function) as a fallback; off by default, never holds a key client-side.

## Local Model (no API key required)

Console includes a dedicated **Local Model** panel that runs a GGUF language model entirely inside the browser tab using [wllama](https://github.com/ngxson/wllama), a WebAssembly binding for llama.cpp:

- No API key, account, or backend of any kind.
- No data leaves the device; inference runs on-device via WebAssembly.
- Pick a curated small model (SmolLM2 135M/360M, Qwen2.5 0.5B, Llama 3.2 1B) or paste any Hugging Face GGUF repo + filename.
- The GGUF file downloads once from Hugging Face and is cached by the browser's Cache API; later loads are instant.
- Once loaded, it becomes the default "Ask Agent" intelligence source and answers questions using only the aggregated telemetry summary Console already builds for the dashboard.

Notes:

- WebAssembly works in every modern browser; no WebGPU is required. Larger models (1B+ parameters) are slower without multi-threading, which needs `Cross-Origin-Embedder-Policy`/`Cross-Origin-Opener-Policy` response headers. Plain GitHub Pages/Vercel static hosting does not set these by default, so the model runs single-threaded by default, which still works, just slower.
- Prefer small Q4_K_M quantized models (a few hundred MB) for a smooth mobile/PWA experience.
- The optional Cloud Agent (OpenRouter via Supabase) described below remains available as a fallback, but is not required at all if you use the Local Model tab.

## Contents

- `index.html` - application shell, HUD markup, module launcher, and the Local Model panel
- `manifest.webmanifest` - PWA install metadata
- `service-worker.js` - offline caching and lifecycle
- `css/tokens.css`, `css/app.css`, `css/states.css` - cinematic dark UI, responsive layout, and state visuals
- `js/state-machine.js` - lost/ghost/manifested lifecycle
- `js/data-firewall.js` - Input -> Trust -> Context -> Action pipeline
- `js/telemetry.js` - module data models (NFC, Wi-Fi, BLE, GPIO, RGB, buzzer)
- `js/joker-adapter.js` - hardware transport abstraction (simulated by default)
- `js/watchdog.js` - background health/alert loop
- `js/storage.js` - AES-256-GCM encrypted IndexedDB vault
- `js/module-detail.js` - per-module live controls and readouts rendered in the Module Detail panel
- `js/local-model.js` - in-browser GGUF model runtime (wllama/WebAssembly), no API key
- `js/agent.js` - optional client for a server-side AI proxy (never calls OpenRouter directly)
- `js/ui.js` - HUD rendering and console feed
- `js/app.js` - orchestration, event wiring, session persistence, vault/buzzer integration
- `js/config.example.js` - copy to `js/config.js` (git-ignored) for local overrides
- `supabase/functions/console-agent/index.ts` - optional Supabase Edge Function template that proxies OpenRouter securely

## Running locally

Any static file server works, for example:

```bash
npx serve .
```

Then open the printed local URL in a browser and use "Add to Home Screen" (mobile) or the browser's install icon (desktop).

## Using the vault

1. Open Settings, type a passphrase, click **Unlock**. The passphrase derives an AES-256-GCM key via PBKDF2 (100k iterations); nothing is sent anywhere.
2. While unlocked, Watchdog alerts and confirmed hardware actions are stored encrypted in IndexedDB.
3. Click **Export Intel** (Command Surface) to decrypt and download a JSON file of vault records.
4. Click **Clear Vault** to permanently delete stored records after a confirmation prompt.
5. Losing the passphrase means losing access to previously stored records; there is no recovery path by design.

## Deploying

### GitHub Pages

1. Settings -> Pages -> Deploy from branch -> `main` / root.
2. Note that GitHub Pages serves static files only. If your account/plan does not support Pages on private repositories, use Vercel instead, or make the repo public knowing there are no secrets in it.

### Vercel

Import this repository as a static project (no build step required); root directory is the repo root. The Local Model feature works out of the box on Vercel since it requires no server code.

## Optional Cloud AI Agent (OpenRouter via Supabase)

This is entirely optional; the Local Model tab is the default, key-free path. If you still want an optional cloud fallback:

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
- The Local Model feature loads third-party WebAssembly and model files from esm.sh (wllama) and Hugging Face over HTTPS on first use; verify you trust those origins for your deployment environment.
- Treat this app as a monitoring/diagnostic console for authorized use on hardware and networks you own or have explicit permission to test.
