import { CFG } from './constants.js';
import { clamp } from './stats.js';
import { MetricForecaster } from './MetricForecaster.js';

const REQUIRED = ['id', 'severity', 'type', 'message', 'createdAt', 'integrityStatus'];
const ALERT_EVENT = { TEMP_PREDICTED: 'threshold_predicted', TEMP_CRITICAL: 'threshold_crossed' };

export class FirewallService {
  /** metrics: optional array of { key, label?, unit?, direction, threshold, horizonSeconds, minConfidence? } to forecast. None are built in. */
  constructor({ bus, store, telemetry, graph, horizon, meta, synthesizer, metrics = [], now = Date.now }) {
    Object.assign(this, { bus, store, telemetry, graph, horizon, meta, synthesizer, now });
    this.forecasters = metrics.map((config) => new MetricForecaster(config));
    this.prevTrend = 'stable';
    this.risingId = null;
  }

  trustScore(data, status) {
    let trust = status === 'OK' ? 1 : status === 'DEGRADED' ? 0.55 : 0;
    if (!data.isStreaming) trust -= 0.2;
    trust -= Math.min(Math.max(0, this.now() - data.timestamp) / CFG.STREAM_TIMEOUT_MS, 1) * 0.3;
    return clamp(trust * this.meta.adjustments().trustScale, 0, 1);
  }

  reject(stage, reason) {
    this.bus.emit('firewall:rejected', { stage, reason });
    return { alert: null, rejected: { stage, reason } };
  }

  emitSampleEvents(sample, cycle) {
    const kinds = [];
    if (sample.nfc) kinds.push('nfc_detected');
    if (sample.isNew) kinds.push('ble_new');
    const startsRising = sample.trend === 'rising' && this.prevTrend !== 'rising';
    if (startsRising) kinds.push('temp_rising');
    if (sample.trend === 'rising' && !startsRising && this.risingId) this.graph.touchEvent(this.risingId, cycle);
    this.prevTrend = sample.trend;
    for (const kind of kinds) {
      const id = `${kind}-${cycle}`;
      this.graph.linkEvent({ id, kind, cycle });
      if (kind === 'temp_rising') this.risingId = id;
    }
  }

  async process() {
    const stage = (name) => this.bus.emit('firewall:stage', { stage: name });
    stage('input');
    if (!(await this.telemetry.detectDevice())) { this.store.patch({ cardState: 'lost' }); return this.reject('input', 'DEVICE_NOT_DETECTED'); }
    // A device that comes back after being lost must be readable again (previously the state stayed 'lost' forever).
    if (this.store.get().cardState === 'lost') this.store.patch({ cardState: 'ghost' });
    const raw = this.telemetry.readRawSample(this.store.get().cardState);
    const { isValid, data, status } = this.telemetry.checkDeviceData(raw);
    if (!isValid) return this.reject('input', 'INVALID_OR_OFFLINE');

    stage('trust');
    const trust = this.trustScore(data, status);
    if (trust < CFG.MIN_TRUST) {
      const degraded = this.synthesizer.degradedByTrust(data, status, trust);
      this.meta.reviewAlert(degraded);
      return { alert: this.accept(degraded), rejected: null };
    }

    stage('context');
    const enriched = this.telemetry.enrichSensorData(data);
    this.graph.observe(enriched);
    const explanation = this.graph.explain('temp');
    const forecast = this.horizon.observe(enriched);
    const metricForecasts = this.forecasters.map((forecaster) => forecaster.observe(enriched.timestamp, enriched[forecaster.config.key]));
    this.emitSampleEvents(enriched, forecast.cycle);
    this.meta.observe(enriched, forecast, status, explanation);
    const ctx = { trust, explanation, forecast, metricForecasts, adjust: this.meta.adjustments() };
    this.store.patch({ cardState: 'manifested', lastSample: enriched, context: ctx });
    this.bus.emit('telemetry:sample', { sample: enriched, ctx });

    stage('action');
    const alert = this.synthesizer.generateAlert(enriched, status, ctx);
    if (alert) {
      const kind = ALERT_EVENT[alert.type];
      if (kind) this.graph.linkEvent({ id: alert.id, kind, cycle: forecast.cycle });
      alert.causality_chain = kind ? this.graph.causalityChain(alert.id) : [];
      alert.explanation = this.synthesizer.explain(alert, ctx, alert.causality_chain);
      this.meta.reviewAlert(alert, CFG.LOW_CONFIDENCE);
    }
    return { alert: this.accept(alert), rejected: null };
  }

  accept(alert) {
    if (!alert || !REQUIRED.every((k) => k in alert)) { if (alert) console.warn('Firewall rejected malformed alert', alert); return null; }
    const history = this.store.get().alertHistory;
    const last = history[history.length - 1];
    if (last && last.type === alert.type && alert.severity !== 'CRITICAL') {
      last.updatedAt = this.now();
      last.state = 'SUPPRESSED';
      this.bus.emit('alert:suppressed', last);
      return null;
    }
    if (alert.forecastClaim) this.meta.registerClaim(alert.forecastClaim);
    const next = [...history, alert].slice(-CFG.ALERT_HISTORY_MAX);
    this.store.patch({ alertHistory: next, lastAlert: alert });
    this.bus.emit('alert:accepted', alert);
    return alert;
  }
}
