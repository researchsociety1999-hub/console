# Card command contract (for the firmware)

Status: DESIGN. The dashboard side is implemented; the firmware (SGP_Card_Joker.ino, config.h, web_ui.h) must implement this.
Until it does, the card answers HTTP 404 on /api/command and the dashboard reports that honestly.

## Request
`POST /api/command` with a JSON body. The dashboard sends Content-Type text/plain so the browser does not send a preflight; parse the body as JSON regardless of content type.

```json
{ "id": "c-lq3x9k2a-17", "cmd": "SET_STATE", "rgb": "joker", "color": [0, 255, 0], "sound": "laugh" }
```
- id: `c-` plus letters, digits or dashes, up to 32 characters. Unique per command.
- cmd: only `SET_STATE` exists.
- rgb: one of joker, rainbow, scanner, breathe, strobe, alarm, off. Optional if sound is given.
- color: optional [r, g, b], each 0 to 255.
- sound: one of none, boot, ok, alarm, coin, laugh. Optional if rgb is given.
- No other fields. No GPIO command is defined yet.

## Response and status
The POST answers (and /api/status then echoes) a lastCommand object:
```json
{ "lastCommand": { "id": "c-lq3x9k2a-17", "state": "applied", "rgb": "joker", "sound": "played", "appliedAtMs": 91234 } }
```
- state pending: received, not yet applied. applied: the firmware has set the LEDs and started the sound. error: failed, with a short `reason`.
- applied means the firmware executed the action. It is not an optical or acoustic check.
- Same id again: do not repeat the effect. Return the stored lastCommand (the dashboard retries up to 3 times with the same id on network failure).
- Unknown fields, bad values or a busy card: state error with a reason, never a silent ignore.

## Browser access
Send `Access-Control-Allow-Origin` on the POST response so a page on http://localhost can read it. If you want JSON content type from the browser, also answer OPTIONS with Allow-Methods, Allow-Headers and the same origin header. Opening the dashboard with ?proxy and `npm run dev:card` avoids cross-origin calls.

## Dashboard rule
SUCCESS is shown only when the returned id matches the sent id and state is applied.
