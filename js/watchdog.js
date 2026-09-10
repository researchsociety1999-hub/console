import jokerAdapter from "./joker-adapter.js";
import { runDataFirewall, finalizeContext, CARD_STATE } from "./data-firewall.js";

/**
 * Watchdog — the God's-Eye loop.
 * Runs a full system health check across all hardware modules every
 * WATCHDOG_INTERVAL_MS (15s). Every module is sampled through
 * jokerAdapter.sampleAllModules(), validated through the Data Firewall,
 * and fused into a single CardState. Critical leaks trigger a dramatic
 * lost -> ghost visual transition via the onCriticalLeak callback.
 */
export const WATCHDOG_INTERVAL_MS = 15000;

export class Watchdog {
  constructor({ adapter = jokerAdapter, onAlert = () => {}, onCriticalLeak = () => {}, onHealthReport = () => {} } = {}) {
    this.adapter = adapter;
    this.onAlert = onAlert;
    this.onCriticalLeak = onCriticalLeak;
    this.onHealthReport = onHealthReport;
    this._timer = null;
    this._active = false;
    this._lastReport = null;
  }

  isActive() {
    return this._active;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._tick();
    this._timer = setInterval(() => this._tick(), WATCHDOG_INTERVAL_MS);
  }

  stop() {
    this._active = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getLastReport() {
    return this._lastReport;
  }

  /**
   * Full System Health Check — runs every 15s, checks all 10 modules.
   */
  _tick() {
    if (!this._active) return;

    // Hard stop: device isolated/powered off takes priority over everything.
    if (this.adapter?.isDevicePoweredOff?.()) {
      const alert = {
        type: "POWER_LOSS",
        severity: "CRITICAL",
        source: "watchdog",
        predicted_state: "OFFLINE",
        recommendation: "RECONNECT_DEVICE_WHEN_READY",
        is_critical_leak: true,
        createdAt: Date.now()
      };
      this.onAlert(alert);
      this._lastReport = { state: CARD_STATE.OFFLINE, modules: [], timestamp: Date.now() };
      this.onHealthReport(this._lastReport);
      return;
    }

    if (!this.adapter?.connected) {
      const alert = {
        type: "CONNECTION_LOST",
        severity: "WARN",
        source: "watchdog",
        predicted_state: "OFFLINE",
        recommendation: "RECONNECT_DEVICE",
        is_critical_leak: false,
        createdAt: Date.now()
      };
      this.onAlert(alert);
      this._lastReport = { state: CARD_STATE.OFFLINE, modules: [], timestamp: Date.now() };
      this.onHealthReport(this._lastReport);
      return;
    }

    const allModuleSamples = this.adapter.sampleAllModules();
    const validatedPackets = [];
    let sawNewBleDevice = null;
    let sawCriticalTelemetryAlert = null;

    for (const rawPacket of allModuleSamples) {
      const result = runDataFirewall(rawPacket);

      if (result.alert) {
        this.onAlert(result.alert);
        if (result.alert.is_critical_leak) {
          sawCriticalTelemetryAlert = result.alert;
        }
      }

      if (result.trusted && !result.input?._invalid) {
        validatedPackets.push(result.trusted);
      }

      if (rawPacket.source_module === "ble" && rawPacket.newDeviceId) {
        sawNewBleDevice = rawPacket.newDeviceId;
      }
    }

    const context = finalizeContext(validatedPackets);
    this._lastReport = context;
    this.onHealthReport(context);

    if (sawNewBleDevice) {
      this.onAlert({
        type: "NEW_BLE_DEVICE",
        severity: "INFO",
        source: "watchdog",
        predicted_state: context.state,
        recommendation: "REVIEW_NEW_DEVICE",
        is_critical_leak: false,
        deviceId: sawNewBleDevice,
        createdAt: Date.now()
      });
    }

    if (context.state === CARD_STATE.LOST) {
      const leakAlert = sawCriticalTelemetryAlert || {
        type: "THERMAL_CRITICAL",
        severity: "CRITICAL",
        source: "watchdog",
        predicted_state: CARD_STATE.LOST,
        recommendation: "INSPECT_THERMAL_MODULE",
        is_critical_leak: true,
        createdAt: Date.now()
      };
      this.onAlert(leakAlert);
    }

    // God's-Eye escalation: any alert flagged is_critical_leak forces a
    // dramatic lost -> ghost visual transition, regardless of source.
    if (sawCriticalTelemetryAlert?.is_critical_leak) {
      this.onCriticalLeak(sawCriticalTelemetryAlert);
    }
  }
}

const watchdog = new Watchdog();
export default watchdog;