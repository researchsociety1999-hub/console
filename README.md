# Console

Console is a local-first, mobile-installable Progressive Web App (PWA) that acts as the command interface for the SGP Joker Card. It unifies proximity/NFC, Wi-Fi, BLE, GPIO, RGB, buzzer, and storage modules into a single 8-panel HUD, driven by a `lost -> ghost -> manifested` state machine and an Input -> Trust -> Context -> Action data firewall.

This repository ships as a **private** source repository. Treat all deployment URLs, API keys, and Supabase project details as sensitive.

## What's implemented

- Explicit, numbered **8-panel HUD**: 01 Proximity Radar, 02 Active Tracking, 03 Link Gauges, 04 Watchdog/Active Assessment, 05 Command Surface, 06 Device Bridge, 07 Awareness Stack, 08 Hack Pipeline.
- **Console/Timeline is the default landing view** — the raw chronological event feed renders immediately below the ribbon, before the HUD.
- 10-module launcher (NFC, WiFi, BLE, BadUSB, GPIO, RGB, Buzzer, Storage, Console, Settings), each with a live **Module Detail** panel.
- `lost -> ghost -> manifested` state machine with a dimmed, essential-only Ghost Protocol UI.
- **Data Firewall** (Input -> Trust -> Context -> Action) enriched by a **ContextEngine** that computes rolling trend, outlier detection, and predictive state before any alert is generated.
- **Watchdog** running every 15 seconds across all 8 hardware modules plus BLE novelty detection, with deduplicated, severity-based, recommendation-carrying alerts.
- **Action Logic** that reads each alert's `recommendation` field and routes it to a real adapter command (module restart, cooling diagnostic, vault logging, etc.).
- AES-256-GCM encrypted local vault (IndexedDB + PBKDF2), with Settings-panel unlock, Export Intel, and Clear Vault.
- Session persistence via `sessionStorage`.
- **Local Model** tab: in-browser GGUF inference via WebAssembly (wllama/llama.cpp), zero API key.
- Optional Cloud Agent (OpenRouter via Supabase Edge Function) as an off-by-default fallback.

## Autonomous Intelligence Architecture (v2)

### ContextEngine (in `js/data-firewall.js`)

- **Trend analysis** — compares the first vs. second half of the last 8 thermal samples to classify `rising`, `falling`, or `stable`.
- **Outlier detection** — flags a thermal sample as `is_outlier` when it deviates more than 2 standard deviations from the recent rolling mean.
- **Predictive logic** — if the trend is `rising` while the band is already `elevated`/`critical`, the engine sets `predictedState = "HIGH_TEMP_STABLE"` and the firewall escalates that to a **CRITICAL** `TEMP_PREDICTED_CRITICAL` alert.

### Full module coverage (10/10)

- `js/telemetry.js` generates a tagged `SensorData` object (`{ source_module, value, ok, timestamp }`) for all 8 hardware modules, each with a small simulated failure chance, plus a shared `seenBle` Set for BLE novelty tracking.
- `js/joker-adapter.js` exposes dedicated module-control functions: `setRgbMode(mode)`, `sendBuzzerTone(freq, duration)`, `setGpioPin(pin, value)`, `restartModule(name)`, and `sampleAllModules()`.

### Watchdog (in `js/watchdog.js`)

- Runs every **15 seconds**, checks thermal trend/threshold, iterates all 8 module samples for `MODULE_FAILURE` alerts, and checks BLE novelty for `BLE_NEW_DEVICE`. Deduplicates non-critical repeats within 30s; CRITICAL always passes through.

### Action Logic (`handleRecommendation()` in `js/app.js`)

| Recommendation | Action taken |
|---|---|
| `RESTART_MODULE:<name>` | Calls `adapter.restartModule(name)`, logs recovery outcome |
| `RUN_COOLING_DIAGNOSTIC` | Sets RGB to `alert-sweep`, sounds the buzzer, updates the agent panel |
| `LOG_AND_MONITOR` | Stores the alert in the encrypted vault (if unlocked) |
| `FLAG_FOR_REVIEW` | Logs and queues the outlier for operator review |
| `MONITOR` (default) | Logged only |

### Severity-driven theme

`setSeverityTheme()` rewrites `--sev-color`/`--sev-glow` on `documentElement` on every alert, cascading live color/glow changes across the ribbon, hero border, metrics, and blips.

## Local Model (no API key required)

Console includes a dedicated **Local Model** panel that runs a GGUF language model entirely inside the browser tab using [wllama](https://github.com/ngxson/wllama), a WebAssembly binding for llama.cpp. No API key, account, or backend of any kind; no data leaves the device.

## Contents

- `index.html` - application shell, explicit 8-panel HUD, module launcher, Local Model panel
- `manifest.webmanifest` - PWA install metadata
- `service-worker.js` - offline caching and lifecycle (cache v3)
- `css/tokens.css`, `css/app.css`, `css/states.css` - cinematic dark UI, severity-driven CSS variables, Ghost/Manifested state visuals
- `js/state-machine.js` - lost/ghost/manifested lifecycle
- `js/data-firewall.js` - Input -> Trust -> Context -> Action pipeline + ContextEngine
- `js/telemetry.js` - SensorData generation for all 8 hardware modules + shared BLE novelty (`seenBle`) tracking
- `js/joker-adapter.js` - hardware transport abstraction with dedicated module-control functions
- `js/watchdog.js` - 15-second background loop: thermal, per-module health, BLE novelty
- `js/storage.js` - AES-256-GCM encrypted IndexedDB vault
- `js/module-detail.js` - per-module live controls and readouts
- `js/local-model.js` - in-browser GGUF model runtime (wllama/WebAssembly), no API key
- `js/agent.js` - optional client for a server-side AI proxy (never calls OpenRouter directly)
- `js/ui.js` - shared DOM/log rendering helpers
- `js/app.js` - orchestration, severity theme, recommendation routing, session persistence
- `js/config.example.js` - copy to `js/config.js` (git-ignored) for local overrides
- `supabase/functions/console-agent/index.ts` - optional Supabase Edge Function template

## Using the vault

1. Open Settings, type a passphrase, click **Unlock**.
2. While unlocked, Watchdog alerts and confirmed hardware actions are stored encrypted in IndexedDB.
3. Click **Export Intel** to decrypt and download a JSON file of vault records.
4. Click **Clear Vault** to permanently delete stored records after a confirmation prompt.
5. Losing the passphrase means losing access to previously stored records; there is no recovery path by design.

## Deploying

### GitHub Pages

Settings -> Pages -> Deploy from branch -> `main` / root. Static hosting only; no secrets are included.

### Vercel

Import this repository as a static project (no build step required).

## Optional Cloud AI Agent (OpenRouter via Supabase)

Entirely optional. The PWA never holds an OpenRouter API key; the Cloud Agent toggle is off by default and, when enabled, only talks to your own Supabase Edge Function, which holds `OPENROUTER_API_KEY` as a server secret.

## Security notes

- No API keys, tokens, or secrets are stored in this repository.
- BadUSB/HID, GPIO, and RGB actions are simulated by default and require explicit user confirmation in the UI.
- The local vault encrypts stored telemetry/history with AES-256-GCM, keyed by a passphrase-derived PBKDF2 key. Losing the passphrase means losing access to that data.
- Treat this app as a monitoring/diagnostic console for authorized use on hardware and networks you own or have explicit permission to test.
