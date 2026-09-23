# Console

Console is a local-first Progressive Web App for monitoring authorized SGP Joker Card or compatible custom-PCB hardware.

## Local-only architecture

- Telemetry is handled in-browser through simulation or Web Bluetooth BLE GATT.
- Local GGUF models run through WebAssembly using `@wllama/wllama`.
- The encrypted Vault uses browser-local IndexedDB.
- Session activity uses tab-scoped `sessionStorage` and is erased on configured lost-state transitions.
- No Supabase function, Cloud Agent, cloud synchronization, remote account, or built-in remote inference service is used.

## Run locally

```bash
npm install
npm run dev
npm test
```

Use a Chromium-based browser over `https:` or `localhost` for Web Bluetooth. The first GGUF model download requires access to Hugging Face; inference remains in the browser after the model loads or is cached.

## Safety and authorization

Console is intended solely for devices, environments, and systems you own or are explicitly authorized to evaluate. The application uses an allow-list for device commands and requires explicit confirmation for the Kill Switch. Local model output is advisory and cannot bypass deterministic hard stops, powered-off state, connection checks, or approved-action controls.

## Deployment

Static deployment is supported through Vercel or another HTTPS static host. `vercel.json` and `_headers` provide frame, MIME, referrer, and Content Security Policy headers. Review the CSP whenever adding a dependency or endpoint.
