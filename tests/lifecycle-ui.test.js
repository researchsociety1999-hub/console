import { describe, expect, it } from 'vitest';
import { CardTelemetrySource } from '../js/sentinel/CardTelemetrySource.js';
import { SentinelConsole } from '../js/sentinel/SentinelConsole.js';
import { UIRenderer } from '../js/sentinel/UIRenderer.js';
import { EventBus } from '../js/sentinel/EventBus.js';

// Test-only transport double and made-up values: they exercise the logic, not the real card.
function makeApp(options = {}) {
  let clock = 1000000;
  let packet = { batteryPct: 80 };
  const transport = { sample: async () => ({ ...packet, provenance: { source: 'card-wifi', deviceId: 'card-1', receivedAt: clock } }) };
  const telemetry = new CardTelemetrySource({
    transport,
    mapPacket: (p) => ({ batteryPct: p.batteryPct, ...(p.ble ? { ble: p.ble } : {}) }),
    requiredFields: ['batteryPct'],
    now: () => clock
  });
  const app = new SentinelConsole({ telemetry, now: () => clock, storage: null, autoAct: false, ...options });
  const step = async (next = {}) => { clock += 10000; packet = { batteryPct: 80, ...next }; return app.runMonitoringCycle(); };
  return { app, step };
}

const device = (id) => ({ ble: { id, rssi: -60 } });

describe('alert lifecycle', () => {
  it('starts ACTIVE, becomes ACKNOWLEDGED on operator acknowledgement, and keeps that state when repeats are suppressed', async () => {
    const { app, step } = makeApp();
    await step(device('a1'));
    const alert = app.store.get().lastAlert;
    expect(alert.type).toBe('BLE_NEW_DEVICE');
    expect(alert.state).toBe('ACTIVE');

    const events = [];
    app.bus.on('alert:acknowledged', (a) => events.push(a));
    expect(app.acknowledge()).toEqual({ ok: true });
    expect(app.store.get().lastAlert.state).toBe('ACKNOWLEDGED');
    expect(events).toHaveLength(1);

    await step(device('a2')); // another new device: same alert type, still open
    const last = app.store.get().lastAlert;
    expect(last.state).toBe('ACKNOWLEDGED');
    expect(last.repeatCount).toBe(1);
  });

  it('does nothing when there is no alert to acknowledge', () => {
    const { app } = makeApp();
    expect(app.acknowledge()).toEqual({ ok: false, reason: 'NO_ACTIVE_ALERT' });
  });

  it('resolves after the configured number of quiet cycles, and a repeat after that is a new alert', async () => {
    const { app, step } = makeApp({ resolveAfterCycles: 3 });
    const resolved = [];
    app.bus.on('alert:resolved', (a) => resolved.push(a));
    await step(device('a1'));
    await step(); await step();
    expect(app.store.get().lastAlert.state).toBe('ACTIVE');
    await step();
    expect(app.store.get().lastAlert.state).toBe('RESOLVED');
    expect(resolved).toHaveLength(1);

    await step(device('a3'));
    expect(app.store.get().alertHistory).toHaveLength(2);
    expect(app.store.get().lastAlert.state).toBe('ACTIVE');
  });

  it('never resolves without the option', async () => {
    const { app, step } = makeApp();
    await step(device('a1'));
    for (let i = 0; i < 6; i++) await step();
    expect(app.store.get().lastAlert.state).toBe('ACTIVE');
  });

  it('validates resolveAfterCycles', () => {
    expect(() => new SentinelConsole({ resolveAfterCycles: 0, storage: null })).toThrow(/resolveAfterCycles/);
  });

  it('waits for the operator instead of acting automatically when autoAct is false', async () => {
    const { app, step } = makeApp();
    const cascades = [];
    app.bus.on('alert:cascade', (c) => cascades.push(c));
    await step(device('a1'));
    expect(cascades[0].result).toEqual({ ok: false, reason: 'AWAITING_OPERATOR' });
    expect(app.store.get().lastAlert.state).toBe('ACTIVE');
    const result = await app.actions.sendAction(app.store.get().lastAlert);
    expect(result).toMatchObject({ ok: true, sentToCard: false });
    expect(app.store.get().lastAlert.state).toBe('ACKNOWLEDGED');
  });
});

const element = () => ({ textContent: '', className: '', disabled: false, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; } });

describe('UIRenderer lifecycle, trust and primary metric', () => {
  it('shows state, trust, buttons and the configured primary metric', () => {
    const ids = ['alertCard', 'alertState', 'ackButton', 'actionButton', 'trustBadge', 'rootCause', 'primaryReading', 'primaryLabel', 'primaryUnit', 'alertMessage', 'device-status'];
    const elements = Object.fromEntries(ids.map((id) => [id, element()]));
    const classes = {};
    const doc = { body: { classList: { toggle(name, on) { classes[name] = Boolean(on); } } }, getElementById: (id) => elements[id] ?? null, querySelector: () => null };
    const bus = new EventBus();
    new UIRenderer({ doc, bus, raf: null, primaryMetric: { key: 'batteryPct', label: 'Battery', unit: '%' } });

    bus.emit('state:changed', {
      cardState: 'ghost',
      lastSample: { timestamp: Date.now(), batteryPct: 83 },
      context: { trust: 0.72 },
      lastAlert: { severity: 'HIGH', state: 'ACKNOWLEDGED', action: 'LOG', message: 'm', integrityStatus: 'OK', rootCause: { summary: 'x' } }
    });

    expect(classes['state-ghost']).toBe(true);
    expect(classes['state-lost']).toBe(false);
    expect(elements.primaryReading.textContent).toBe('83.0');
    expect(elements.primaryLabel.textContent).toBe('Battery');
    expect(elements.primaryUnit.textContent).toBe('%');
    expect(elements.trustBadge.textContent).toBe('Trust 72%');
    expect(elements.alertState.textContent).toBe('ACKNOWLEDGED');
    expect(elements.alertCard.attrs['data-state']).toBe('ACKNOWLEDGED');
    expect(elements.ackButton.disabled).toBe(true);
    expect(elements.actionButton.disabled).toBe(false);
    expect(elements.actionButton.textContent).toBe('Log this');
    expect(elements.rootCause.textContent).toBe('x');
  });

  it('disables both buttons for a resolved alert and shows no root cause for metric alerts', () => {
    const ids = ['alertCard', 'ackButton', 'actionButton', 'rootCause'];
    const elements = Object.fromEntries(ids.map((id) => [id, element()]));
    const doc = { body: { classList: { toggle() {} } }, getElementById: (id) => elements[id] ?? null, querySelector: () => null };
    const bus = new EventBus();
    new UIRenderer({ doc, bus, raf: null });
    bus.emit('state:changed', { cardState: 'manifested', lastSample: null, lastAlert: { severity: 'LOW', state: 'RESOLVED', action: 'LOG', metric: 'batteryPct', rootCause: { summary: 'ambient' } } });
    expect(elements.ackButton.disabled).toBe(true);
    expect(elements.actionButton.disabled).toBe(true);
    expect(elements.rootCause.textContent).toBe('');
  });

  it('plays the alert tone only when the operator turned it on', () => {
    const bus = new EventBus();
    const renderer = new UIRenderer({ doc: { body: { classList: { toggle() {} } }, getElementById: () => null, querySelector: () => null }, bus, raf: null });
    let created = 0;
    globalThis.AudioContext = class { constructor() { created += 1; throw new Error('no audio in tests'); } };
    try {
      renderer.beep(440, 10);
      expect(created).toBe(0);
      renderer.soundEnabled = true;
      renderer.beep(440, 10);
      expect(created).toBe(1);
    } finally {
      delete globalThis.AudioContext;
    }
  });
});

describe('UIRenderer detail card', () => {
  it('lists the evidence and signal strength but never the device identity', () => {
    const body = { children: [], replaceChildren(...rows) { this.children = rows; } };
    const card = { hidden: true };
    const title = element();
    const lookup = { detailCard: card, detailBody: body, detailTitle: title };
    const doc = {
      body: { classList: { toggle() {} } },
      getElementById: (id) => lookup[id] ?? null,
      querySelector: () => null,
      createElement: () => ({ className: '', textContent: '', children: [], append(...children) { this.children = children; } })
    };
    const renderer = new UIRenderer({ doc, bus: new EventBus(), raf: null });

    const shown = renderer.showDetail(
      { type: 'BLE_NEW_DEVICE', severity: 'HIGH', state: 'ACTIVE', createdAt: 0, message: 'm', explanation: 'e', confidence_score: 0.8, integrityStatus: 'OK', causality_chain: [], recommendation: 'Log it' },
      { ble: { id: 'raw-address', rssi: -65 } }
    );
    expect(shown).toBe(true);
    expect(card.hidden).toBe(false);
    expect(title.textContent).toBe('BLE_NEW_DEVICE (HIGH)');
    const text = body.children.map((row) => row.children.map((c) => c.textContent).join(': ')).join('\n');
    expect(text).toContain('Nearby device signal: -65 dBm');
    expect(text).toContain('Evidence: e');
    expect(text).not.toContain('raw-address');

    renderer.hideDetail();
    expect(card.hidden).toBe(true);
  });

  it('does nothing without an alert or without the elements', () => {
    const renderer = new UIRenderer({ doc: { body: { classList: { toggle() {} } }, getElementById: () => null, querySelector: () => null }, bus: new EventBus(), raf: null });
    expect(renderer.showDetail({ type: 'X' }, null)).toBe(false);
  });
});
