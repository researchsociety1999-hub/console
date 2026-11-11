import { CARD_PROTOCOL } from './card-protocol.js';
import { CARD_BLE_PROTOCOL } from './card-ble-protocol.js';

/**
 * Picks which card link to open for Connect.
 * - wifi: card AP HTTP poll (/api/status); WebSocket frames are not captured yet
 * - ble: Web Bluetooth (works from HTTPS / Vercel once CARD_BLE_PROTOCOL is filled)
 * - demo: in-browser simulation only
 * - auto: BLE on HTTPS when configured, otherwise Wi-Fi
 */
export function resolveLinkChoice(mode = 'auto', pageProtocol = globalThis.location?.protocol) {
  const normalized = String(mode || 'auto').toLowerCase();
  if (normalized === 'demo') {
    return { kind: 'demo', descriptor: null, reason: 'Demo mode uses local simulation only.' };
  }
  if (normalized === 'wifi') {
    return {
      kind: 'wifi',
      descriptor: CARD_PROTOCOL,
      reason: 'Wi-Fi link uses the card AP status API (HTTP poll).'
    };
  }
  if (normalized === 'ble') {
    if (!CARD_BLE_PROTOCOL) {
      return {
        kind: 'ble',
        descriptor: null,
        reason: 'BLE is not configured yet. Capture GATT UUIDs in js/transports/card-ble-protocol.js.'
      };
    }
    return { kind: 'ble', descriptor: CARD_BLE_PROTOCOL, reason: 'BLE link uses Web Bluetooth GATT.' };
  }

  // auto
  if (pageProtocol === 'https:' && CARD_BLE_PROTOCOL) {
    return {
      kind: 'ble',
      descriptor: CARD_BLE_PROTOCOL,
      reason: 'HTTPS page: using BLE so the browser can reach the card without mixed-content blocks.'
    };
  }
  return {
    kind: 'wifi',
    descriptor: CARD_PROTOCOL,
    reason: pageProtocol === 'https:'
      ? 'HTTPS page (e.g. Vercel): Wi-Fi to the card AP is plain HTTP and will be blocked unless you use localhost HTTP or configure BLE.'
      : 'Using Wi-Fi card AP status poll.'
  };
}

export function connectionHint(pageProtocol = globalThis.location?.protocol) {
  if (pageProtocol === 'https:') {
    return 'Vercel/HTTPS: join the card Wi-Fi, then prefer BLE once configured. Plain HTTP to 192.168.4.1 is blocked by the browser. For Wi-Fi polling use http://localhost while on the card AP.';
  }
  return 'Local HTTP: Connect over Wi-Fi while this machine is on the card access point (default http://192.168.4.1).';
}
