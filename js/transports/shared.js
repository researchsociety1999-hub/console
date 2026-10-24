/**
 * Shared helpers for real card transports.
 * Nothing in this file generates, defaults or invents telemetry.
 */

export function requireFunction(value, label) {
  if (typeof value !== 'function') {
    throw new Error(`Card protocol descriptor is missing ${label}.`);
  }
}

export function requirePositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Card protocol descriptor ${label} must be a positive number.`);
  }
}

/** Returns { id, name } only when both are non-empty strings; otherwise null. */
export function validateIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const id = typeof identity.id === 'string' ? identity.id.trim() : '';
  const name = typeof identity.name === 'string' ? identity.name.trim() : '';
  return id && name ? { id, name } : null;
}

/**
 * Holds the most recent validated packet. receivedAt is the browser receive time,
 * NOT a sensor timestamp, unless the protocol provides one inside the packet.
 */
export class LatestPacketStore {
  constructor({ staleAfterMs, now = Date.now }) {
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    this.entry = null;
  }

  set(packet) {
    this.entry = { packet, receivedAt: this.now() };
  }

  clear() {
    this.entry = null;
  }

  /** Returns the entry only while it is fresh; stale data is dropped, never returned. */
  fresh() {
    if (!this.entry) return null;
    if (this.now() - this.entry.receivedAt > this.staleAfterMs) {
      this.entry = null;
      return null;
    }
    return this.entry;
  }
}

export function withProvenance(entry, source, identity) {
  return {
    ...entry.packet,
    provenance: { source, deviceId: identity.id, receivedAt: entry.receivedAt }
  };
}
