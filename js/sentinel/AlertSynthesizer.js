import { CFG } from './constants.js';
import { clamp } from './stats.js';

const LABELS = { nfc_detected: 'an NFC tag was detected', ble_new: 'a new BLE device appeared', temp_rising: 'the temperature began rising' };

export class AlertSynthesizer {
  constructor({ now = Date.now } = {}) { this.now = now; }

  base(data, status, extra) {
    const createdAt = this.now();
    return {
      id: `alert-${data.sourceModule}-${data.timestamp}`,
      severity: 'LOW',
      type: 'TEMP_CRITICAL',
      message: '',
      createdAt,
      integrityStatus: status,
      recommendation: 'Monitor Trend.',
      action: 'MONITOR',
      predictedState: 'NOMINAL',
      isCriticalLeak: false,
      affectedAssetId: CFG.CARD_ID,
      state: 'ACTIVE',
      data_payload: { value: data.temperatureC, trend: data.trend, units: '°C', dataQuality: status, freshness: createdAt - data.timestamp },
      ...extra
    };
  }

  generateAlert(data, status, ctx) {
    const alert = this.build(data, status, ctx);
    return alert ? this.finalize(alert, ctx) : null;
  }

  finalize(alert, ctx) {
    const forecastConfidence = alert.forecastConfidence ?? 1;
    const causeConfidence = ctx.explanation?.confidence ?? 0;
    alert.predicted_state = alert.predictedState;
    alert.confidence_score = Number(clamp(ctx.trust * (0.5 + 0.5 * forecastConfidence) * (0.75 + 0.25 * causeConfidence), 0, 1).toFixed(3));
    return alert;
  }

  explain(alert, ctx, chain) {
    const slope = ctx.forecast?.slope ?? 0;
    const cause = chain.find((c) => c.kind === 'nfc_detected' || c.kind === 'ble_new') ?? chain[0];
    const parts = [];
    if (cause) parts.push(`Because ${LABELS[cause.kind] ?? cause.kind} ${cause.cyclesAgo} cycle(s) earlier (causal link)`);
    const trend = alert.data_payload?.trend;
    if (trend && trend !== 'stable') parts.push(`the temperature is ${trend} (${slope >= 0 ? '+' : ''}${slope.toFixed(2)}°C/cycle)`);
    if (ctx.forecast?.ttcCycles != null && alert.type === 'TEMP_PREDICTED') parts.push(`the system predicts the ${CFG.TEMP_CRITICAL_C}°C threshold will be breached in ${Math.ceil(ctx.forecast.ttcCycles)} cycle(s)`);
    if (!parts.length) return alert.message;
    const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
    return `${alert.severity}: ${text}.`;
  }

  build(data, status, ctx) {
    const temp = data.temperatureC;
    const numeric = Number.isFinite(temp) && temp !== 0;
    const meta = { trust: ctx.trust, rootCause: ctx.explanation, horizon: ctx.forecast.ready ? ctx.forecast : null };

    if (data.isNew) {
      return this.base(data, status, { ...meta, severity: 'HIGH', type: 'BLE_NEW_DEVICE', message: `New BLE device ${data.ble.id} at ${data.ble.rssi} dBm.`, recommendation: 'Log and Monitor this new device.', action: 'LOG', predictedState: 'NEW' });
    }
    if (status === 'DEGRADED' && data.sourceModule !== 'NFC') {
      return this.base(data, status, { ...meta, severity: 'MEDIUM', type: 'MODULE_FAILURE', message: `Module ${data.sourceModule} reporting degraded data.`, recommendation: `Run ${data.sourceModule} diagnostic.`, action: 'RESTART_MODULE', predictedState: 'DEGRADED' });
    }
    if (numeric && temp > CFG.TEMP_CRITICAL_C) {
      const msg = `Temperature ${temp.toFixed(1)}°C exceeds ${CFG.TEMP_CRITICAL_C}°C.`;
      if (data.trend === 'rising') return this.base(data, status, { ...meta, severity: 'CRITICAL', message: msg, recommendation: 'IMMINENT FAILURE: Initiate Cooling Diagnostic.', action: 'RUN_COOLING_DIAGNOSTIC', predictedState: 'CRITICAL', isCriticalLeak: true });
      if (temp > CFG.TEMP_EXTREME_C) return this.base(data, status, { ...meta, severity: 'CRITICAL', message: msg, recommendation: 'IMMEDIATE ACTION: Shut down system!', action: 'SHUTDOWN', predictedState: 'CRITICAL', isCriticalLeak: true });
      return this.base(data, status, { ...meta, severity: 'HIGH', message: msg, recommendation: 'Acknowledge Alert and run System Diagnostic.', action: 'RUN_COOLING_DIAGNOSTIC', predictedState: 'HIGH_TEMP_STABLE' });
    }
    const predictive = this.predictiveAlert(data, status, ctx, meta);
    if (predictive) return predictive;
    if (numeric && temp < CFG.TEMP_LOW_C) {
      return this.base(data, status, { ...meta, severity: 'LOW', message: `Temperature ${temp.toFixed(1)}°C is low.`, recommendation: 'Check environment/insulation.', action: 'FLAG_FOR_REVIEW', predictedState: 'LOW_TEMP_STABLE' });
    }
    return null;
  }

  predictiveAlert(data, status, ctx, meta) {
    const f = ctx.forecast;
    if (!f.ready || f.ttcCycles === null || f.ttcCycles > CFG.PREDICT_TTC_CYCLES) return null;
    const margin = ctx.adjust.escalationMargin;
    const hit = f.horizons.find((h) => h.predicted >= CFG.TEMP_CRITICAL_C + margin && h.confidence >= CFG.PREDICT_CONFIDENCE_MIN);
    if (!hit) return null;
    return this.base(data, status, {
      ...meta,
      type: 'TEMP_PREDICTED',
      severity: f.ttcCycles <= 1 ? 'HIGH' : 'MEDIUM',
      message: `Forecast crosses ${CFG.TEMP_CRITICAL_C}°C in ~${Math.max(1, Math.round(f.ttcSeconds))}s (confidence ${(hit.confidence * 100).toFixed(0)}%).`,
      recommendation: 'Run Cooling Diagnostic before threshold is reached.',
      action: 'RUN_COOLING_DIAGNOSTIC',
      predictedState: 'WARMING',
      forecastConfidence: hit.confidence,
      forecastClaim: { threshold: CFG.TEMP_CRITICAL_C, byCycle: f.cycle + Math.ceil(f.ttcCycles) + 1 }
    });
  }

  degradedByTrust(data, status, trust) {
    return this.base(data, status, { severity: 'MEDIUM', type: 'DATA_DEGRADED', message: `Low-trust telemetry (trust ${trust.toFixed(2)}).`, recommendation: 'Verify sensor health.', action: 'FLAG_FOR_REVIEW', predictedState: 'DEGRADED', trust, predicted_state: 'DEGRADED', confidence_score: Number(trust.toFixed(3)), causality_chain: [] });
  }
}
