import { createFrameParser } from './frame-parser.js';

/**
 * Card protocol descriptor for the SGP Card Joker, written from a status response captured from the
 * card's own panel (see docs/CARD_STATUS_API.md).
 *
 * It reads GET /api/status. It deliberately does NOT call the radar scan address (the scan ties the
 * card up and the card was seen dropping connections around it) and it sends no commands. The panel
 * also opens a WebSocket, but its path and frames have not been captured, so it is not used here.
 */
const CARD_ADDRESS = 'http://192.168.4.1'; // apIP reported by the card itself
const BOARD_NAME_PART = 'SGP Card Joker';

// Opening sentinel.html?proxy and running `npm run dev:card` sends the calls through this computer
// instead of straight to the card, in case the browser blocks cross-origin calls to the card.
const useProxy = typeof location !== 'undefined' && new URLSearchParams(location.search).has('proxy');

const isCardStatus = (value) => value !== null && typeof value === 'object' && typeof value.board === 'string' && value.board.includes(BOARD_NAME_PART);

const statusParser = createFrameParser({
  format: 'json',
  match: isCardStatus,
  fields: {
    heap: { type: 'number', path: 'heap', min: 0 },
    minHeap: { type: 'number', path: 'minHeap', min: 0 },
    uptime: { type: 'string', path: 'uptime', maxLength: 16 },
    clients: { type: 'number', path: 'clients', min: 0 },
    channel: { type: 'number', path: 'channel', min: 1, max: 14 },
    batPct: { type: 'number', path: 'batPct', required: false },
    nfcPresent: { type: 'boolean', path: 'nfc.present', required: false },
    nfcFw: { type: 'string', path: 'nfc.fw', required: false, maxLength: 16 }
  }
});

export const CARD_PROTOCOL = {
  kind: 'wifi',
  baseUrl: useProxy ? location.origin : CARD_ADDRESS,
  identity: {
    path: '/api/status',
    responseType: 'json',
    // The card must say it is an SGP Card Joker and give a hardware id. The id stays inside the transport and is never displayed.
    parse(body) {
      if (!isCardStatus(body)) return null;
      if (typeof body.mac !== 'string' || !body.mac) return null;
      return { id: body.mac, name: body.board };
    }
  },
  telemetry: {
    mode: 'poll',
    path: '/api/status',
    responseType: 'text', // the parser reads the JSON text itself
    staleAfterMs: 45000, // three monitoring cycles of 15 s
    parse: statusParser.parse,
    validate: statusParser.validate
  }
};
