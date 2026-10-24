import { describe, expect, it } from 'vitest';
import { CardTelemetrySource } from '../js/sentinel/CardTelemetrySource.js';
import { SentinelConsole } from '../js/sentinel/SentinelConsole.js';
import { GraphService } from '../js/sentinel/GraphService.js';
import { AlertSynthesizer } from '../js/sentinel/AlertSynthesizer.js';
import { UIRenderer } from '../js/sentinel/UIRenderer.js';
import { EventBus } from '../js/sentinel/EventBus.js';

// Test-only transport double and made-up numbers: they exercise the logic, not the real card.
const batteryMetric = { key: 'batteryPct', label: 'Battery', unit: '%', direction: 'below', threshold: 20, horizonSeconds: 600 };

function makeApp(metrics) {
  let clock = 1000000;
  let level = 60;
  const transport = { sample: async () => ({ batteryPct: level, provenance: { source: 'card-wifi', deviceId: 'card-1', receivedAt: clock } }) };
  const telemetry = new CardTelemetrySource({ transport, mapPacket: (p) => ({ batteryPct: p.batteryPct }), requiredFields: ['batteryPct'], now: () => clock });
  const app = new SentinelConsole({ telemetry, now: () => clock, storage: null, metrics });
  const step = async () => { clock += 10000; level -= 1; return app.runMonitoringCycle(); };
  return { app, step };
}

describe('metric alerts end to end', () => {
  it('raises a forecast alert with time-to-threshold and confidence for a configured metric', async () => {
    const { app, step } = makeApp([batteryMetric]);
    const alerts = [];
    app.bus.on('alert:accepted', (a) => alerts.push(a));
    for (let i = 0; i < 14; i++) await step();

    const alert = alerts.find((a) => a.type === 'METRIC_PREDICTED');
    expect(alert).toBeTruthy();
    expect(alert.message).toMatch(/^Battery forecast to cross 20% in ~\d+s \(confidence \d+%\)\.$/);
    expect(Number.isFinite(alert.ttcSeconds)).toBe(true);
    expect(alert.causality_chain).toEqual([]);
    expect(alert.data_payload.metric).toBe('batteryPct');
    expect(app.store.get().cardState).toBe('manifested');
  });

  it('raises no metric alerts when no metric is configured', async () => {
    const { app, step } = makeApp([]);
    const alerts = [];
    app.bus.on('alert:accepted', (a) => alerts.push(a));
    for (let i = 0; i < 14; i++) await step();
    expect(alerts.filter((a) => String(a.type).startsWith('METRIC_'))).toEqual([]);
  });
});

describe('CardTelemetrySource data quality', () => {
  const source = new CardTelemetrySource({ transport: { sample: async () => null }, mapPacket: () => ({}), requiredFields: ['batteryPct'] });

  it('is OK only when every required field is present', () => {
    expect(source.checkDeviceData({ isPresent: true, batteryPct: 80 }).status).toBe('OK');
    expect(source.dataQuality).toBe('OK');
    const degraded = source.checkDeviceData({ isPresent: true });
    expect(degraded.status).toBe('DEGRADED');
    expect(degraded.missing).toEqual(['batteryPct']);
    expect(source.checkDeviceData({ isPresent: true, batteryPct: Number.NaN }).status).toBe('DEGRADED');
  });

  it('is OFFLINE without a sample', () => {
    expect(source.checkDeviceData(null)).toMatchObject({ isValid: false, status: 'OFFLINE' });
  });

  it('reports freshness from the latest sample', async () => {
    let clock = 5000;
    const fresh = new CardTelemetrySource({ transport: { sample: async () => ({ batteryPct: 1, provenance: { receivedAt: 4000 } }) }, mapPacket: (p) => ({ batteryPct: p.batteryPct }), now: () => clock });
    expect(fresh.freshnessMs).toBeNull();
    await fresh.detectDevice();
    expect(fresh.freshnessMs).toBe(1000);
    clock = 7000;
    expect(fresh.freshnessMs).toBe(3000);
  });
});

describe('co-occurrence wording', () => {
  it('marks causality chain items as co-occurred', () => {
    const g = new GraphService();
    g.linkEvent({ id: 'nfc-5', kind: 'nfc_detected', cycle: 5 });
    g.linkEvent({ id: 'rise-7', kind: 'temp_rising', cycle: 7 });
    expect(g.causalityChain('rise-7')).toEqual([{ id: 'nfc-5', kind: 'nfc_detected', cyclesAgo: 2, relation: 'co-occurred' }]);
  });

  it('does not state a proven cause in the explanation', () => {
    const text = new AlertSynthesizer().explain({ severity: 'HIGH', data_payload: {}, type: 'X', message: 'm' }, { forecast: {} }, [{ kind: 'nfc_detected', cyclesAgo: 2 }]);
    expect(text).toContain('co-occurred, not a proven cause');
    expect(text).not.toMatch(/causal link/i);
  });
});

describe('UIRenderer forecast display', () => {
  it('shows the chain, forecast and freshness when the elements exist', () => {
    const ids = ['alertChain', 'alertForecast', 'freshnessTag', 'dataQualityTag', 'alertExplanation', 'confidenceScore', 'device-status', 'primaryReading', 'alertMessage'];
    const elements = Object.fromEntries(ids.map((id) => [id, { textContent: '', className: '' }]));
    const doc = { body: { classList: { toggle() {} } }, getElementById: (id) => elements[id] ?? null, querySelector: () => null };
    const bus = new EventBus();
    new UIRenderer({ doc, bus, raf: null });

    bus.emit('state:changed', {
      cardState: 'manifested',
      lastSample: { timestamp: Date.now() },
      lastAlert: {
        severity: 'HIGH', message: 'm', integrityStatus: 'OK', predicted_state: 'TRENDING', explanation: 'e', confidence_score: 0.8,
        causality_chain: [{ kind: 'nfc_detected', cyclesAgo: 2, relation: 'co-occurred' }], ttcSeconds: 120, forecastConfidence: 0.9
      }
    });

    expect(elements.alertChain.textContent).toBe('nfc detected (2 cycle(s) earlier, co-occurred)');
    expect(elements.alertForecast.textContent).toBe('Forecast: ~120s to threshold (confidence 90%)');
    expect(elements.freshnessTag.textContent).toBe('Last update: just now');
    expect(elements.dataQualityTag.textContent).toBe('Data quality: OK');
    expect(elements.primaryReading.textContent).toBe('--');
  });
});
