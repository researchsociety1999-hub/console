import { CFG } from './constants.js';

const isBad = (v) => v === null || v === undefined || Number.isNaN(v) || v === 0;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v !== 0;

export class TelemetryEngine {
  constructor({ rng = Math.random, now = Date.now, detectDelayMs = 50 } = {}) {
    this.rng = rng;
    this.now = now;
    this.detectDelayMs = detectDelayMs;
    this.temps = [];
    this.bleSeen = new Map();
  }

  async detectDevice() {
    if (this.detectDelayMs > 0) await new Promise((r) => setTimeout(r, this.detectDelayMs));
    return this.rng() > 0.03;
  }

  readRawSample(cardState) {
    if (cardState === 'lost') return null;
    const timestamp = this.now();
    if (this.rng() < 0.15) {
      return { sourceModule: 'THERMAL', temperatureC: null, batteryPct: null, isStreaming: false, isPresent: true, timestamp };
    }
    const glitch = this.rng();
    let temperatureC;
    if (glitch < 0.08) temperatureC = null;
    else if (glitch < 0.14) temperatureC = NaN;
    else if (glitch < 0.18) temperatureC = 0;
    else temperatureC = 18 + this.rng() * 10;
    const sample = { sourceModule: 'THERMAL', temperatureC, batteryPct: Math.round(40 + this.rng() * 60), isStreaming: true, isPresent: true, timestamp };
    if (this.rng() < 0.1) sample.ble = { id: `ble-${Math.floor(this.rng() * 6)}`, rssi: Math.round(-95 + this.rng() * 40) };
    if (this.rng() < 0.08) sample.nfc = { tag: `tag-${Math.floor(this.rng() * 4)}` };
    return sample;
  }

  checkDeviceData(sample) {
    if (!sample || !sample.isPresent) return { isValid: false, data: sample ?? null, status: 'OFFLINE' };
    const data = { ...sample };
    if (isBad(data.temperatureC) || isBad(data.batteryPct)) return { isValid: true, data, status: 'DEGRADED' };
    return { isValid: true, data, status: data.temperatureC < CFG.TEMP_LOW_C ? 'DEGRADED' : 'OK' };
  }

  enrichSensorData(data) {
    const temp = isNum(data.temperatureC) ? data.temperatureC : null;
    const last = this.temps.length ? this.temps[this.temps.length - 1] : null;
    const delta = temp !== null && last !== null ? Math.abs(temp - last) : 0;
    if (temp !== null) { this.temps.push(temp); if (this.temps.length > 60) this.temps.shift(); }
    const window = this.temps.slice(-CFG.TEMP_TREND_WINDOW);
    const change = window.length >= 2 ? window[window.length - 1] - window[0] : 0;
    const trend = change > CFG.TEMP_TREND_THRESHOLD ? 'rising' : change < -CFG.TEMP_TREND_THRESHOLD ? 'falling' : 'stable';
    return { ...data, delta, trend, isNew: this.detectBleNovelty(data), isOutlier: temp !== null && (temp > CFG.TEMP_EXTREME_C || temp < CFG.TEMP_LOW_C), isChange: delta > CFG.TEMP_TREND_THRESHOLD };
  }

  detectBleNovelty(data) {
    if (!data.ble || data.ble.rssi < CFG.BLE_NOVELTY_RSSI) return false;
    const seenAt = this.bleSeen.get(data.ble.id);
    this.bleSeen.set(data.ble.id, data.timestamp);
    return seenAt === undefined || data.timestamp - seenAt > CFG.BLE_NOVELTY_WINDOW_MS;
  }
}
