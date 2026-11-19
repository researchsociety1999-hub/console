export const HEADER_GPIO_PINS = Object.freeze([48, 34, 33, 47, 26, 35, 36, 37, 38, 39, 40, 8, 7, 3]);
export const COMMAND_RGB_MODES = Object.freeze(['joker', 'rainbow', 'scanner', 'breathe', 'strobe', 'alarm', 'off']);
export const COMMAND_SOUNDS = Object.freeze(['none', 'boot', 'ok', 'alarm', 'coin', 'laugh']);

const COMMAND_ID = /^c-[A-Za-z0-9-]{1,32}$/;
const ALLOWED_KEYS = ['id', 'cmd', 'rgb', 'color', 'sound'];
const isByte = (value) => Number.isInteger(value) && value >= 0 && value <= 255;

export function isHeaderGpioPin(pin) {
  return Number.isInteger(pin) && HEADER_GPIO_PINS.includes(pin);
}

/** Local safety check run before any command leaves the browser. Only SET_STATE is allowed for now. */
export function validateCommandRequest(request) {
  const fail = (reason) => ({ ok: false, reason });
  if (!request || typeof request !== 'object' || Array.isArray(request)) return fail('NOT_AN_OBJECT');
  if (typeof request.id !== 'string' || !COMMAND_ID.test(request.id)) return fail('INVALID_COMMAND_ID');
  if (request.cmd !== 'SET_STATE') return fail('COMMAND_NOT_ALLOWED');
  if (Object.keys(request).some((key) => !ALLOWED_KEYS.includes(key))) return fail('UNEXPECTED_FIELDS');
  if (request.rgb === undefined && request.sound === undefined) return fail('NOTHING_TO_SET');
  if (request.rgb !== undefined && !COMMAND_RGB_MODES.includes(request.rgb)) return fail('INVALID_RGB_MODE');
  if (request.sound !== undefined && !COMMAND_SOUNDS.includes(request.sound)) return fail('INVALID_SOUND');
  if (request.color !== undefined && !(Array.isArray(request.color) && request.color.length === 3 && request.color.every(isByte))) return fail('INVALID_COLOR');
  return { ok: true };
}
