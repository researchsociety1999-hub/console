# Card status data (captured from the real card, 2026-10-27)

Source: the card's own web panel at its access-point address, request `GET /api/status`, about 551 bytes of JSON.
Name, MAC and Wi-Fi name were removed before sharing.

## Fields seen

| Field | Example | How the dashboard uses it |
|---|---|---|
| `board` | `SGP Card Joker / ESP32-S3-MINI-1-N8` | Checks that the device really is the card; shown as the device name |
| `heap` | 104720 (bytes) | Free memory: main reading and forecast |
| `minHeap` | 90724 (bytes) | Lowest free memory since the card started |
| `uptime` | `00:01:19` | Converted to seconds; a drop means the card restarted |
| `clients` | 1 | Devices joined to the card's Wi-Fi |
| `channel` | 6 | Wi-Fi channel |
| `nfc.present`, `nfc.fw` | true, `1.6` | NFC reader present and its firmware |
| `batPct`, `vbat` | -1, -1 | -1 means not measured; shown as not available, never as 0 |
| `rssi` | 0 | No information on this card; ignored |
| `name`, `mac`, `apSSID` | removed | Identify the owner's device or network; never kept or shown |
| `usb`, `pin*`, `jiggle`, `flash`, `chip`, `rev`, `cores`, `cpu`, `sdk`, `apIP`, `batWarn`, `version` | various | Not used |

There is no temperature field.

## Other addresses seen in the panel
- `GET /api/radar?secs=2`: starts a 2-second scan. It was often reset by the card and is **not** used by the dashboard.
- A WebSocket on the card's address (status 101). Its path and frames have not been captured, so it is not used yet.

## Observed behaviour
- The panel polls `/api/status` every few seconds; some answers took 3 to 9 seconds and many requests ended in `ERR_CONNECTION_RESET`.
- The card was seen with a 3 KB minimum free memory after a busy session, and 88 KB after a restart. The dashboard polls only every 15 seconds and never starts scans.

## Open questions
- Does `/api/status` send `Access-Control-Allow-Origin`? If not, open `sentinel.html?proxy` and start the server with `npm run dev:card`.
- What does the WebSocket carry, and at which path?
- Which commands (LED, buzzer) exist, and how does the card acknowledge them?
- What sets `batPct`/`vbat`? The panel has a battery divider setting; until it is configured the card reports -1.
