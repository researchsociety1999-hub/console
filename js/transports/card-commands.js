import { CardCommandError } from './card-protocol.js';
import { validateCommandRequest } from '../command-rules.js';

const DEFAULT_ATTEMPTS = 3;
let counter = 0;

/** Builds a command id such as c-lq3x9k2a-17 (matches the id rule in command-rules.js). */
export function createRequestId(now = Date.now) {
  counter = (counter + 1) % 1000000;
  return `c-${now().toString(36)}-${counter}`;
}

/** Only network failures, timeouts and HTTP 5xx are retried. A card answer (error, pending, 4xx) never is. */
const isRetryable = (error) => {
  const message = error?.message ?? '';
  return error?.name === 'TypeError' || /^Request to .* timed out/.test(message) || /returned HTTP 5[0-9][0-9]/.test(message);
};

/** Translates the card lastCommand object into the console command-result fields. */
export function mapCommandResponse(lastCommand) {
  if (!lastCommand || typeof lastCommand !== 'object' || typeof lastCommand.id !== 'string') return null;
  const commandStatus = { applied: 'OK', error: 'ERROR', pending: 'PENDING' }[lastCommand.state];
  if (!commandStatus) return null;
  return { commandId: lastCommand.id, commandStatus, rgbState: lastCommand.rgb, soundState: lastCommand.sound, appliedAtMs: lastCommand.appliedAtMs, reason: lastCommand.reason };
}

/**
 * Sends SET_STATE through a connected CardWifiTransport. The same command id is reused on every attempt, so the
 * firmware must ignore a repeated id. Resolves with the acknowledgement only for a matching id in state applied.
 * Rejects with CardCommandError: REJECTED_LOCALLY, ID_MISMATCH, PENDING, CARD_ERROR, BAD_RESPONSE, COMMAND_TIMEOUT.
 * Other errors (not connected, HTTP 404, commands disabled) are passed through unchanged.
 */
export async function sendSetState(transport, request, { attempts = DEFAULT_ATTEMPTS } = {}) {
  const check = validateCommandRequest(request);
  if (!check.ok) throw new CardCommandError('REJECTED_LOCALLY', `Command rejected locally: ${check.reason}.`, { reason: check.reason });
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const ack = await transport.invokeCommand('SET_STATE', request);
      if (ack?.id !== request.id) throw new CardCommandError('ID_MISMATCH', 'The card answered for a different command id.', { id: ack?.id });
      return { ...ack, attempts: attempt };
    } catch (error) {
      if (error instanceof CardCommandError || !isRetryable(error)) throw error;
      lastError = error;
    }
  }
  throw new CardCommandError('COMMAND_TIMEOUT', `No usable response after ${attempts} attempt(s): ${lastError?.message ?? 'unknown error'}`, { attempts });
}
