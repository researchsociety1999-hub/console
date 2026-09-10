// Watchdog — the God's-Eye loop.
// Runs every `intervalMs` (app.js passes 15000) while `isActive()` is true.
// Sequence each tick: BLE novelty first, then per-module health, then
// thermal / predictive trend last. Every alert emitted follows the shape
// consumed by app.js's handleRecommendation()/render():
//   { type, severity: "low"|"medium"|"high"|"critical", predicted_state,
//     trend, recommendation, is_critical_leak, ... }

const THERMAL_HISTORY_LEN = 6;
const THERMAL_WARN_C = 60;
const THERMAL_HIGH_C = 75;
const THERMAL_CRITICAL_C = 85;

export class Watchdog {
  constructor({ intervalMs = 15000, isActive = () => true, getThermalSample = () => null, getModuleSamples = () => [], onAlert = () => {} } = {}) {
    this.intervalMs = intervalMs;
    this.isActive = isActive;
    this.getThermalSample = getThermalSample;
    this.getModuleSamples = getModuleSamples;
    this.onAlert = onAlert;

    this._timer = null;
    this._thermalHistory = [];
    this._knownBleIds = new Set();
    this._moduleFaultStreak = new Map();
  }

  start() {
    if (this._timer) return;
    this._tick();
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _emit(alert) {
    this.onAlert({ createdAt: Date.now(), ...alert });
  }

  _tick() {
    if (!this.isActive()) return;

    // 1) BLE NOVELTY — checked first, per the original design intent.
    const moduleSamples = this.getModuleSamples() || [];
    const bleSample = moduleSamples.find((s) => s.source_module === "ble");
    const newDeviceId = bleSample?.newDeviceId ?? bleSample?.value?.newDeviceId ?? null;

    if (newDeviceId && !this._knownBleIds.has(newDeviceId)) {
      this._knownBleIds.add(newDeviceId);
      this._emit({
        type: "NEW_BLE_DEVICE",
        severity: "low",
        predicted_state: "NOMINAL",
        trend: "stable",
        recommendation: "LOG_AND_MONITOR",
        is_critical_leak: false,
        deviceId: newDeviceId
      });
    }

    // 2) PER-MODULE HEALTH — flag modules reporting DEGRADED or !ok for
    //    two consecutive ticks as a real fault, not sensor noise.
    for (const sample of moduleSamples) {
      const moduleName = sample.source_module;
      const unhealthy = sample.ok === false || sample.data_quality === "DEGRADED";
      const streak = unhealthy ? (this._moduleFaultStreak.get(moduleName) || 0) + 1 : 0;
      this._moduleFaultStreak.set(moduleName, streak);

      if (streak === 2) {
        this._emit({
          type: "MODULE_FAULT",
          severity: "medium",
          predicted_state: "DEGRADED",
          trend: "stable",
          recommendation: `RESTART_MODULE:${moduleName}`,
          is_critical_leak: false,
          module: moduleName
        });
      } else if (streak > 4) {
        this._emit({
          type: "MODULE_FAULT_PERSISTENT",
          severity: "high",
          predicted_state: "DEGRADED",
          trend: "stable",
          recommendation: "FLAG_FOR_REVIEW",
          is_critical_leak: false,
          module: moduleName
        });
      }
    }

    // 3) THERMAL / PREDICTIVE TREND — checked last so it can consider
    //    the module health picture already gathered above.
    const thermal = this.getThermalSample();
    if (typeof thermal !== "number" || Number.isNaN(thermal)) return;

    this._thermalHistory.push(thermal);
    if (this._thermalHistory.length > THERMAL_HISTORY_LEN) this._thermalHistory.shift();

    const trend = this._computeTrend();
    const sustainedHigh =
      this._thermalHistory.length >= 3 &&
      this._thermalHistory.slice(-3).every((t) => t >= THERMAL_CRITICAL_C);

    if (sustainedHigh) {
      this._emit({
        type: "THERMAL_CRITICAL",
        severity: "critical",
        predicted_state: "CRITICAL",
        trend,
        recommendation: "RUN_COOLING_DIAGNOSTIC_IMMEDIATE",
        is_critical_leak: true,
        temperatureC: thermal
      });
    } else if (thermal >= THERMAL_CRITICAL_C) {
      this._emit({
        type: "THERMAL_HIGH",
        severity: "critical",
        predicted_state: "CRITICAL",
        trend,
        recommendation: "RUN_COOLING_DIAGNOSTIC_IMMEDIATE",
        is_critical_leak: false,
        temperatureC: thermal
      });
    } else if (thermal >= THERMAL_HIGH_C) {
      this._emit({
        type: "THERMAL_ELEVATED",
        severity: "high",
        predicted_state: "ELEVATED",
        trend,
        recommendation: "RUN_COOLING_DIAGNOSTIC",
        is_critical_leak: false,
        temperatureC: thermal
      });
    } else if (thermal >= THERMAL_WARN_C && trend === "rising") {
      this._emit({
        type: "THERMAL_RISING",
        severity: "medium",
        predicted_state: "WATCH",
        trend,
        recommendation: "MONITOR",
        is_critical_leak: false,
        temperatureC: thermal
      });
    }
  }

  _computeTrend() {
    const h = this._thermalHistory;
    if (h.length < 2) return "stable";
    const delta = h[h.length - 1] - h[0];
    if (delta > 1.5) return "rising";
    if (delta < -1.5) return "falling";
    return "stable";
  }
}
