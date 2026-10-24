import { TelemetryEngine } from './TelemetryEngine.js';

const present = (value) => value !== undefined && value !== null && !(typeof value === 'number' && !Number.isFinite(value));

/**
 * Feeds Sentinel from a REAL card transport instead of the random generator.
 * mapPacket(packet) must convert a validated transport packet into a Sentinel sample
 * (for example { batteryPct, ble, nfc }) using only fields the card really sends;
 * it must return null when it cannot. Fields the card does not provide stay undefined.
 * requiredFields lists the sample fields that must be present for the data to count as OK;
 * a sample missing any of them is DEGRADED. (The old behaviour treated every sample without a
 * temperature as degraded, which a card with no temperature sensor can never satisfy.)
 */
export class CardTelemetrySource extends TelemetryEngine {
  constructor({ transport, mapPacket, requiredFields = [], now = Date.now } = {}) {
    super({ now, detectDelayMs: 0 });
    if (!transport || typeof transport.sample !== 'function') throw new Error('CardTelemetrySource needs a real card transport.');
    if (typeof mapPacket !== 'function') throw new Error('CardTelemetrySource needs mapPacket(packet) -> Sentinel sample | null.');
    if (!Array.isArray(requiredFields)) throw new Error('requiredFields must be an array of sample field names.');
    this.transport = transport;
    this.mapPacket = mapPacket;
    this.requiredFields = requiredFields;
    this.latest = null;
    this.lastError = null;
    this.lastStatus = 'OFFLINE';
  }

  async refresh() {
    try {
      const packet = await this.transport.sample();
      this.latest = packet ? this.toSample(packet) : null;
      this.lastError = null;
    } catch (error) {
      this.latest = null; // a failed or stale read never leaves old data showing
      this.lastError = error;
    }
    if (!this.latest) this.lastStatus = 'OFFLINE';
    return this.latest;
  }

  toSample(packet) {
    const mapped = this.mapPacket(packet);
    if (!mapped || typeof mapped !== 'object') return null;
    const timestamp = packet.provenance?.receivedAt; // browser receive time, not a sensor time
    if (!Number.isFinite(timestamp)) return null;
    return { sourceModule: 'CARD', isPresent: true, isStreaming: true, ...mapped, timestamp };
  }

  /** True only when a fresh, validated packet just arrived. */
  async detectDevice() { return (await this.refresh()) !== null; }

  readRawSample() { return this.latest; }

  /** OK only when every required field is present; DEGRADED lists what is missing; OFFLINE when there is no sample. */
  checkDeviceData(sample) {
    if (!sample || !sample.isPresent) {
      this.lastStatus = 'OFFLINE';
      return { isValid: false, data: sample ?? null, status: 'OFFLINE' };
    }
    const data = { ...sample };
    const missing = this.requiredFields.filter((field) => !present(data[field]));
    const status = missing.length ? 'DEGRADED' : 'OK';
    this.lastStatus = status;
    return { isValid: true, data, status, missing };
  }

  /** Milliseconds since the latest sample was received, or null when there is none. */
  get freshnessMs() {
    return this.latest ? Math.max(0, this.now() - this.latest.timestamp) : null;
  }

  get dataQuality() { return this.lastStatus; }
}
