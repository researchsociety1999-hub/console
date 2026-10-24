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
  constructor({ rng, now = Date.now, confirm, commandBridge, telemetry, metrics = [], storage = globalThis.sessionStorage, setTimer = setTimeout, clearTimer = clearTimeout, detectDelayMs } = {}) {
    this.now = now;
    this.storage = storage;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
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
  }

  async handleAlertCascade(alert) {
    try {
      const result = await this.actions.sendAction(alert);
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

  async runMonitoringCycle() {
    const { alert } = await this.firewall.process();
    if (alert) await this.handleAlertCascade(alert);
    return alert;
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
