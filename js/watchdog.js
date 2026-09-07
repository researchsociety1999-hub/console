// Watchdog: self-running background intelligence loop.
// Runs every 15 seconds (per mandate). Each tick samples all 8 hardware
// modules through the Data Firewall, checks BLE novelty against
// telemetry.js's shared `seenBle` set, and raises deduplicated,
// severity-based alerts -- proactively, independent of user focus.

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

    // --- Thermal watch (rule: temperature + predictive trend) ---
    const thermal = this.getThermalSample();
    if (typeof thermal === "number") {
      const result = runDataFirewall({ source: "thermal", value: thermal, moduleOk: true });
      this._emit(result.alert);
    }

    // --- Per-module health watch (rule: specific module failures) ---
    const samples = this.getModuleSamples();
    for (const sample of samples) {
      if (!sample) continue;

      // Module failure path.
      if (sample.ok === false) {
        const result = runDataFirewall({ source: sample.source_module, value: sample.value, moduleOk: false });
        this._emit(result.alert);
        continue;
      }

      // BLE novelty path: uses the module's own newDeviceId flag, which is
      // itself derived from telemetry.js's shared `seenBle` Set.
      if (sample.source_module === "ble" && sample.newDeviceId) {
        const result = runDataFirewall({ source: "ble", value: sample.newDeviceId, moduleOk: true, isNew: true });
        this._emit(result.alert);
      }
    }
  }
}
