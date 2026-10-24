import { requireFunction } from './shared.js';

/**
 * Builds strict frame parsers from a declarative spec. The spec's match(), field paths/offsets,
 * ranges and identity check MUST come from captured frames of the real card (see
 * tools/ws-recorder.js). Nothing here knows the card's protocol, and nothing defaults a missing
 * value to 0, false or a baseline.
 */

const FORMATS = ['json', 'text', 'binary'];
const FIELD_TYPES = ['number', 'string', 'boolean'];
const BINARY_KINDS = { u8: [1, 'getUint8'], i8: [1, 'getInt8'], u16: [2, 'getUint16'], i16: [2, 'getInt16'], u32: [4, 'getUint32'], i32: [4, 'getInt32'], f32: [4, 'getFloat32'] };
const MAX_STRING = 128;

function decode(frame, format) {
  if (format === 'json') {
    if (typeof frame !== 'string') return undefined;
    try { return JSON.parse(frame); } catch { return undefined; }
  }
  if (format === 'text') return typeof frame === 'string' ? frame : undefined;
  if (frame instanceof ArrayBuffer) return new DataView(frame);
  if (ArrayBuffer.isView(frame)) return new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  return undefined;
}

function safeMatch(spec, decoded) {
  try { return spec.match(decoded) === true; } catch { return false; }
}

function getPath(object, path) {
  return String(path).split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), object);
}

function readRaw(decoded, field, spec) {
  if (spec.format === 'json') return getPath(decoded, field.path);
  if (spec.format === 'text') return spec.pattern.exec(decoded)?.groups?.[field.group];
  const [size, method] = BINARY_KINDS[field.kind];
  if (field.offset + size > decoded.byteLength) return undefined;
  return decoded[method](field.offset, spec.littleEndian === true);
}

function coerce(raw, field, spec) {
  if (raw === undefined || raw === null) return undefined;
  if (field.type === 'number') {
    let n;
    if (typeof raw === 'number') n = raw;
    else if (spec.format === 'text' && typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
    else return undefined;
    if (!Number.isFinite(n)) return undefined;
    return field.scale === undefined ? n : n * field.scale;
  }
  if (field.type === 'string') return typeof raw === 'string' && raw.length <= (field.maxLength ?? MAX_STRING) ? raw : undefined;
  if (field.type === 'boolean') return typeof raw === 'boolean' ? raw : undefined;
  return undefined;
}

function validateSpec(spec) {
  if (!spec || !FORMATS.includes(spec.format)) throw new Error(`Frame spec format must be one of: ${FORMATS.join(', ')}.`);
  requireFunction(spec.match, 'match');
  if (spec.format === 'text' && (!(spec.pattern instanceof RegExp) || spec.pattern.global || spec.pattern.sticky)) {
    throw new Error('Text frame specs need a RegExp without the g or y flag.');
  }
  if (!spec.fields || typeof spec.fields !== 'object' || Object.keys(spec.fields).length === 0) throw new Error('Frame spec needs at least one field.');
  for (const [name, field] of Object.entries(spec.fields)) {
    if (!field || !FIELD_TYPES.includes(field.type)) throw new Error(`Field "${name}" needs a type of ${FIELD_TYPES.join(', ')}.`);
    if (spec.format === 'json' && typeof field.path !== 'string') throw new Error(`Field "${name}" needs a path.`);
    if (spec.format === 'text' && typeof field.group !== 'string') throw new Error(`Field "${name}" needs a named group.`);
    if (spec.format === 'binary' && (!BINARY_KINDS[field.kind] || !Number.isInteger(field.offset) || field.offset < 0)) {
      throw new Error(`Field "${name}" needs a kind (${Object.keys(BINARY_KINDS).join(', ')}) and a non-negative integer offset.`);
    }
  }
}

/** Builds { parse, validate } for the descriptor's telemetry section. */
export function createFrameParser(spec) {
  validateSpec(spec);
  const names = Object.keys(spec.fields);
  return {
    parse(frame) {
      const decoded = decode(frame, spec.format);
      if (decoded === undefined || !safeMatch(spec, decoded)) return null; // not a telemetry frame
      const packet = {};
      for (const name of names) {
        const value = coerce(readRaw(decoded, spec.fields[name], spec), spec.fields[name], spec);
        if (value !== undefined) packet[name] = value; // a missing field stays missing
      }
      return packet;
    },
    validate(packet) {
      for (const name of names) {
        const field = spec.fields[name];
        const value = packet[name];
        if (value === undefined) {
          if (field.required !== false) throw new Error(`Missing field "${name}".`);
          continue;
        }
        if (field.type === 'number' && ((field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) {
          throw new Error(`Field "${name}" is out of range.`);
        }
        if (field.oneOf && !field.oneOf.includes(value)) throw new Error(`Field "${name}" has an unexpected value.`);
      }
      return packet;
    }
  };
}

/** Builds identity.parse for identity: { from: 'websocket' }. verify() must prove the sender is the Joker card. */
export function createIdentityParser(spec) {
  validateSpec({ ...spec, fields: { id: spec.id, name: spec.name } });
  requireFunction(spec.verify, 'verify');
  return (frame) => {
    const decoded = decode(frame, spec.format);
    if (decoded === undefined || !safeMatch(spec, decoded)) return null;
    const id = coerce(readRaw(decoded, spec.id, spec), spec.id, spec);
    const name = coerce(readRaw(decoded, spec.name, spec), spec.name, spec);
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) return null;
    return spec.verify({ id, name }) === true ? { id, name } : null;
  };
}
