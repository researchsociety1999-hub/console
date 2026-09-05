// Watchdog: background policy evaluation loop.
// Consumes trusted samples via the data firewall and emits deduplicated,
// severity-based alerts on an interval, independent of user focus.

import { runDataFirewall } from "./data-firewall.js";

export class Watchdog {
  constructor({ intervalMs = 10000, onAlert, getSample, isActive }) {
    this.intervalMs = intervalMs;
    this.onAlert = onAlert || (() => {});
    this.getSample = getSample;
    this.isActive = isActive || (() => true);
    this._timer = null;
    this._lastAlertKey = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    if (!this.isActive()) return;
    const sample = this.getSample?.();
    if (!sample) return;

    const result = runDataFirewall({ source: "thermal", value: sample.thermal });
    if (!result.alert) return;

    const key = `${result.alert.type}:${result.alert.severity}`;
    if (key === this._lastAlertKey && result.alert.severity !== "critical") return;
    this._lastAlertKey = key;
    this.onAlert(result.alert);
  }
}
