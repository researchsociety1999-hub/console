import { TelemetryEngine } from './TelemetryEngine.js';

/**
 * Feeds Sentinel from a REAL card transport instead of the random generator.
 * mapPacket(packet) must convert a validated transport packet into a Sentinel sample
 * (for example { batteryPct, ble, nfc, temperatureC? }) using only fields the card really sends;
 * it must return null when it cannot. Fields the card does not provide stay undefined, so the
 * sample is reported DEGRADED instead of being filled with invented values.
 */
export class CardTelemetrySource extends TelemetryEngine {
  constructor({ transport, mapPacket, now = Date.now } = {}) {
    super({ now, detectDelayMs: 0 });
    if (!transport || typeof transport.sample !== 'function') throw new Error('CardTelemetrySource needs a real card transport.');
    if (typeof mapPacket !== 'function') throw new Error('CardTelemetrySource needs mapPacket(packet) -> Sentinel sample | null.');
    this.transport = transport;
    this.mapPacket = mapPacket;
    this.latest = null;
    this.lastError = null;
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
}
