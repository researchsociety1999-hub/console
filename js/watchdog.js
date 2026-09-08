// Watchdog: self-running background intelligence loop.
// Runs every 15 seconds. Each tick checks BLE novelty FIRST (proactive
// sensing, independent of temperature), then per-module data_quality
// health across all 8 hardware modules, then the thermal/predictive
// trend check last -- matching the mandate that BLE novelty must be able
// to raise a HIGH alert before the temperature ever crosses a threshold.

import { runDataFirewall } from "./data-firewall.js";

const WATCHDOG_INTERVAL_MS = 15000;

export class Watchdog {
  constructor({ intervalMs = WATCHDOG_INTERVAL_MS, onAlert, getModuleSamples, getThermalSample, isActive }) {
    this.intervalMs = intervalMs;
    this.onAlert = onAlert || (() => {});
    this.getModuleSamples = getModuleSamples || (() => []);
    this.getThermalSample = getThermalSample || (() => null);
    this.isActive = isActive || (() => true);
    this._timer = null;
    this._lastAlertKeys = new Map(); // type -> last emitted timestamp, for dedupe
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _emit(alert) {
    if (!alert) return;
    const key = alert.type;
    const last = this._lastAlertKeys.get(key);
    const now = Date.now();
    // Always let CRITICAL through; otherwise suppress repeats within 30s.
    if (alert.severity !== "critical" && last && now - last < 30000) return;
    this._lastAlertKeys.set(key, now);
    this.onAlert(alert);
  }

  _tick() {
    if (!this.isActive()) return;

    const samples = this.getModuleSamples();

    // --- 1. BLE Novelty Check (proactive, runs FIRST) ---
    const bleSample = samples.find((s) => s && s.source_module === "ble");
    if (bleSample && bleSample.ok && bleSample.newDeviceId) {
      const result = runDataFirewall({ source: "ble", value: bleSample.newDeviceId, dataQuality: "OK", isNew: true });
      this._emit(result.alert);
    }

    // --- 2. Per-module health watch (data_quality DEGRADED -> MODULE_FAILURE) ---
    for (const sample of samples) {
      if (!sample || sample.source_module === "ble") continue;
      if (sample.data_quality === "DEGRADED") {
        const result = runDataFirewall({ source: sample.source_module, value: sample.value, dataQuality: "DEGRADED" });
        this._emit(result.alert);
      }
    }

    // --- 3. Thermal + predictive trend check (runs LAST) ---
    const thermal = this.getThermalSample();
    if (typeof thermal === "number") {
      const result = runDataFirewall({ source: "thermal", value: thermal, dataQuality: "OK" });
      this._emit(result.alert);
    }
  }
}
