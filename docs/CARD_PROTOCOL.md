# Card protocol facts (fill in from evidence only)

The dashboard cannot talk to the SGP Card Joker until these facts are documented. Do not guess any of them.
For each fact, record where it came from (HAR file, sniffer output, firmware source file and version, vendor page).

## Device
- Board and firmware version:
- How the card is reached (its own Wi-Fi access point and web panel, BLE, USB serial, other):
- Access point name and address, and whether the panel needs a login:

## Wi-Fi panel (capture with `tools/panel-sniffer.js` or DevTools > Network > Save all as HAR)
- Identity request (path, method) and a redacted sample response that proves the device is the Joker card:
- Telemetry: polled over HTTP or pushed over WebSocket / server-sent events; path; interval; sample frame (redacted):
- Field names, types, units and valid ranges for each module (NFC, Wi-Fi scan, BLE scan, radar, battery, others):
- Whether payloads carry a device timestamp or sequence number:
- Command requests (RGB, buzzer, others): path, method, body, and what the acknowledgement looks like:
- Whether the panel sends CORS headers that allow another origin to call it:

## BLE (only if the firmware exposes a GATT service)
- Advertised name or service UUIDs:
- Telemetry service and characteristic UUIDs, and whether they notify or read:
- Byte layout, byte order, scaling and units:
- How to verify the device identity (for example a readable identity characteristic):
- Tip: nRF Connect (mobile) lists all services; Web Bluetooth can only read services you name in advance.

## Browser and environment
- Browser and OS used for the test:
- How the dashboard was served (it must be http://localhost, or HTTPS if the card itself is HTTPS, because browsers block HTTPS pages from calling plain-HTTP addresses):

Once filled in, write the descriptor in `js/transports/card-protocol.js` and pass it to `new JokerAdapter(createTransportFromDescriptor(CARD_PROTOCOL))` after the removal-of-simulation patch is applied.
