/**
 * BLE protocol descriptor for the SGP Card Joker.
 *
 * Left unset on purpose: GATT service/characteristic UUIDs have not been captured yet
 * (see docs/CARD_PROTOCOL.md). Do not invent UUIDs. When evidence exists, export a
 * descriptor shaped like:
 *
 * {
 *   kind: 'ble',
 *   filters: [{ namePrefix: '...' }] or [{ services: ['...'] }],
 *   identity: { service, characteristic, mode: 'read', parse },
 *   telemetry: { mode: 'notify'|'read', service, characteristic, staleAfterMs, parse, validate }
 * }
 *
 * Until then, HTTPS deploys (Vercel) cannot talk to the card's plain-HTTP Wi-Fi API
 * because browsers block mixed content. Use http://localhost on the card AP, or fill this in.
 */
export const CARD_BLE_PROTOCOL = null;
