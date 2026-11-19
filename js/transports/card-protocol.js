import { createFrameParser } from './frame-parser.js';

/**
 * Card protocol descriptor for the SGP Card Joker.
 *  - Status: GET /api/status (captured from the real card, docs/CARD_STATUS_API.md).
 *  - Commands: POST /api/command SET_STATE (docs/CARD_COMMAND_CONTRACT.md). This is a CONTRACT for firmware
 *    that must implement it. Until the card is flashed with it, the card answers HTTP 404 and the app says so.
 * No radar scan and no WebSocket are used here.
 */
const CARD_ADDRESS = 'http://192.168.4.1'; // apIP reported by the card itself
const BOARD_NAME_PART = 'SGP Card Joker';
const COMMAND_STATES = ['pending', 'applied', 'error'];

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
    nfcFw: { type: 'string', path: 'nfc.fw', required: false, maxLength: 16 },
    cmdId: { type: 'string', path: 'lastCommand.id', required: false, maxLength: 40 },
    cmdState: { type: 'string', path: 'lastCommand.state', required: false, oneOf: COMMAND_STATES },
    cmdRgb: { type: 'string', path: 'lastCommand.rgb', required: false, maxLength: 24 },
    cmdSound: { type: 'string', path: 'lastCommand.sound', required: false, maxLength: 24 },
    cmdAppliedAtMs: { type: 'number', path: 'lastCommand.appliedAtMs', required: false, min: 0 },
    cmdReason: { type: 'string', path: 'lastCommand.reason', required: false, maxLength: 64 }
  }
});

/** Thrown by the SET_STATE acknowledgement parser and the retry helper. code tells the caller what happened. */
export class CardCommandError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CardCommandError';
    this.code = code;
    Object.assign(this, details);
  }
}

/** The POST response must carry lastCommand. Only state applied counts as acknowledged. */
function parseSetStateAck(response) {
  const last = response && typeof response === 'object' ? response.lastCommand : null;
  if (!last || typeof last !== 'object' || typeof last.id !== 'string' || !COMMAND_STATES.includes(last.state)) {
    throw new CardCommandError('BAD_RESPONSE', 'The card response had no valid lastCommand.');
  }
  const detail = { id: last.id, rgb: last.rgb, sound: last.sound, appliedAtMs: last.appliedAtMs, reason: last.reason, raw: response };
  if (last.state === 'applied') return { acknowledged: true, state: 'applied', ...detail };
  if (last.state === 'pending') throw new CardCommandError('PENDING', 'The card has the command but has not applied it yet.', { ...detail, state: 'pending' });
  throw new CardCommandError('CARD_ERROR', `The card reported an error${last.reason ? `: ${last.reason}` : ''}.`, { ...detail, state: 'error' });
}

export const CARD_PROTOCOL = {
  kind: 'wifi',
  baseUrl: useProxy ? location.origin : CARD_ADDRESS,
  allowCommands: true,
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
  },
  commands: {
    SET_STATE: {
      path: '/api/command',
      method: 'POST',
      responseType: 'json',
      // text/plain keeps this a simple cross-origin request, so the browser sends no OPTIONS preflight. The firmware parses the body as JSON anyway.
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      buildBody: (params) => JSON.stringify({ ...params, cmd: 'SET_STATE' }),
      parseAck: parseSetStateAck
    }
  }
};
