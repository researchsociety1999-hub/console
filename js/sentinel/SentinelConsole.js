import { CFG } from './constants.js';
import { EventBus } from './EventBus.js';
import { Store } from './Store.js';
import { TelemetryEngine } from './TelemetryEngine.js';
import { GraphService } from './GraphService.js';
import { HorizonPredictor } from './HorizonPredictor.js';
import { MetacognitiveService } from './MetacognitiveService.js';
import { AlertSynthesizer } from './AlertSynthesizer.js';
import { FirewallService } from './FirewallService.js';
import { ActionService } from './ActionService.js';

const SESSION_KEY = 'sentinel-console-session-v1';

export class SentinelConsole {
  /**
   * autoAct (default true): run an alert's action automatically. The live page sets it to false so actions run only when the operator clicks.
   * resolveAfterCycles (default null): mark the latest alert RESOLVED after this many consecutive cycles with no alert or repeat.
   */
  constructor({ rng, now = Date.now, confirm, commandBridge, telemetry, metrics = [], autoAct = true, resolveAfterCycles = null, storage = globalThis.sessionStorage, setTimer = setTimeout, clearTimer = clearTimeout, detectDelayMs } = {}) {
    if (resolveAfterCycles !== null && (!Number.isInteger(resolveAfterCycles) || resolveAfterCycles < 1)) throw new Error('resolveAfterCycles must be a positive integer or null.');
    this.now = now;
    this.storage = storage;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.autoAct = autoAct;
    this.resolveAfterCycles = resolveAfterCycles;
    this.quietCycles = 0;
    this.suppressedThisCycle = false;
    this.bus = new EventBus();
    this.store = new Store(this.bus);
    this.telemetry = telemetry ?? new TelemetryEngine({ rng, now, detectDelayMs });
    this.graph = new GraphService();
    this.meta = new MetacognitiveService({ bus: this.bus, graph: this.graph });
    this.horizon = new HorizonPredictor({ getAdjustments: () => this.meta.adjustments() });
    this.synthesizer = new AlertSynthesizer({ now });
    this.firewall = new FirewallService({ bus: this.bus, store: this.store, telemetry: this.telemetry, graph: this.graph, horizon: this.horizon, meta: this.meta, synthesizer: this.synthesizer, metrics, now });
    this.actions = new ActionService({ bus: this.bus, store: this.store, telemetry: this.telemetry, confirm, commandBridge, now });
    this.running = false;
    this.timer = null;
    this.bus.on('alert:accepted', () => this.persist());
    this.bus.on('alert:suppressed', () => { this.suppressedThisCycle = true; });
  }

  async handleAlertCascade(alert) {
    try {
      const result = this.autoAct ? await this.actions.sendAction(alert) : { ok: false, reason: 'AWAITING_OPERATOR' };
      this.bus.emit('alert:cascade', { alert, result });
      if (alert.severity === 'CRITICAL' || alert.severity === 'HIGH') {
        this.bus.emit('feedback:buzzer', { freq: alert.severity === 'CRITICAL' ? 880 : 440, duration: 500 });
      }
      return result;
    } catch (error) {
      console.error('Alert cascade failed:', error);
      return { ok: false, reason: 'CASCADE_ERROR' };
    }
  }

  /** Operator acknowledgement. This is recorded in the console only; it sends nothing to the card. */
  acknowledge(alert = this.store.get().lastAlert) {
    if (!alert || alert.state === 'RESOLVED') return { ok: false, reason: 'NO_ACTIVE_ALERT' };
    alert.state = 'ACKNOWLEDGED';
    alert.acknowledgedAt = this.now();
    this.store.patch({ lastAlert: alert });
    this.bus.emit('alert:acknowledged', alert);
    return { ok: true };
  }

  resolveActive() {
    const last = this.store.get().lastAlert;
    if (!last || last.state === 'RESOLVED') return false;
    last.state = 'RESOLVED';
    last.resolvedAt = this.now();
    this.store.patch({ lastAlert: last, alertHistory: [...this.store.get().alertHistory] });
    this.bus.emit('alert:resolved', last);
    return true;
  }

  noteCycle({ alert, rejected }) {
    if (alert || this.suppressedThisCycle) { this.quietCycles = 0; return; }
    if (rejected) return; // no fresh data: neither confirms nor clears an alert
    this.quietCycles += 1;
    if (this.resolveAfterCycles && this.quietCycles >= this.resolveAfterCycles) this.resolveActive();
  }

  async runMonitoringCycle() {
    this.suppressedThisCycle = false;
    const result = await this.firewall.process();
    if (result.alert) await this.handleAlertCascade(result.alert);
    this.noteCycle(result);
    return result.alert;
  }

  startMonitoringLoop() {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      try { await this.runMonitoringCycle(); } catch (error) { console.error('Monitoring cycle failed:', error); }
      if (this.running) this.timer = this.setTimer(tick, CFG.WATCHDOG_INTERVAL_MS);
    };
    tick().catch((e) => console.error(e));
  }

  stopMonitoringLoop() {
    this.running = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }

  async initConsole() {
    this.restore();
    const present = await this.telemetry.detectDevice();
    this.store.patch({ cardState: present ? 'manifested' : 'lost' });
    if (present) this.startMonitoringLoop();
  }

  persist() {
    try {
      const s = this.store.get();
      this.storage?.setItem(SESSION_KEY, JSON.stringify({ alerts: s.alertHistory, cardState: s.cardState, meta: this.meta.toJSON() }));
    } catch { /* storage unavailable */ }
  }

  restore() {
    try {
      const saved = JSON.parse(this.storage?.getItem(SESSION_KEY) ?? 'null');
      if (saved) this.store.patch({ alertHistory: saved.alerts ?? [], cardState: saved.cardState ?? 'lost' });
    } catch { /* corrupt session ignored */ }
  }
}
