import { test } from 'vitest';
import assert from 'node:assert/strict';
import { SentinelConsole } from '../js/sentinel/SentinelConsole.js';
import { TelemetryEngine } from '../js/sentinel/TelemetryEngine.js';
import { HorizonPredictor } from '../js/sentinel/HorizonPredictor.js';
import { GraphService } from '../js/sentinel/GraphService.js';
import { MetacognitiveService } from '../js/sentinel/MetacognitiveService.js';
import { EventBus } from '../js/sentinel/EventBus.js';
import { UIRenderer } from '../js/sentinel/UIRenderer.js';

const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const mk = (seed, extra = {}) => { let clock = 1e6; return new SentinelConsole({ rng: mulberry(seed), now: () => (clock += 100), detectDelayMs: 0, storage: null, ...extra }); };

class Scripted extends TelemetryEngine {
  constructor(seq, now) { super({ detectDelayMs: 0, now }); this.seq = seq; this.i = 0; }
  async detectDevice() { return true; }
  readRawSample() { const s = this.seq[this.i++]; return { sourceModule: 'THERMAL', temperatureC: s.t, batteryPct: 80, isStreaming: true, isPresent: true, timestamp: this.now(), ...(s.nfc ? { nfc: { tag: 'tag-1' } } : {}) }; }
}
const scripted = (seq) => { let c = 1e6; const now = () => (c += 1); return new SentinelConsole({ now, telemetry: new Scripted(seq, now), storage: null }); };

test('200 simulated cycles: stages in order, no throw, features live', async () => {
  const app = mk(42); const stages = []; const alerts = []; let meta = 0;
  app.bus.on('firewall:stage', (e) => stages.push(e.stage));
  app.bus.on('alert:accepted', (a) => alerts.push(a));
  app.bus.on('meta:updated', () => meta++);
  app.store.patch({ cardState: 'manifested' });
  for (let i = 0; i < 200; i++) await app.runMonitoringCycle();
  assert.equal(stages[0], 'input'); assert.ok(stages.includes('context') && stages.includes('action'));
  assert.ok(alerts.length > 0); assert.ok(meta > 0);
  for (const a of alerts) assert.ok(['id','severity','type','message','createdAt','integrityStatus','recommendation','action','predicted_state','confidence_score','causality_chain'].every((k) => k in a), JSON.stringify(Object.keys(a)));
  assert.ok(app.store.get().alertHistory.length <= 100);
});

test('PHASE 1: a newly emitted event links to the previous causal event (adjacency list + chain)', () => {
  const g = new GraphService();
  g.linkEvent({ id: 'nfc-5', kind: 'nfc_detected', cycle: 5 });
  const rising = g.linkEvent({ id: 'rise-7', kind: 'temp_rising', cycle: 7 });
  const pred = g.linkEvent({ id: 'pred-8', kind: 'threshold_predicted', cycle: 8 });
  assert.deepEqual(rising.causes, ['nfc-5']); assert.deepEqual(pred.causes, ['rise-7']);
  assert.deepEqual(g.causalityChain('pred-8').map((c) => c.kind), ['nfc_detected', 'temp_rising']);
  assert.equal(g.linkEvent({ id: 'rise-40', kind: 'temp_rising', cycle: 40 }).causes.length, 0, 'stale cause not linked');
});

test('PHASE 1b: lagged variable edge is learned from data', () => {
  const g = new GraphService(); let prev = 0;
  for (let i = 0; i < 60; i++) { const ble = i % 3 === 0 ? 1 : 0; g.observe({ temperatureC: 20 + prev * 3 + (i % 5) * 0.01, batteryPct: 80, isStreaming: true, ble: ble ? {} : null }); prev = ble; }
  assert.ok(g.edges['bleActivity->temp'].learned > 0.5); assert.equal(g.explain('temp').topCause, 'bleActivity');
});

test('PHASE 2: alert is created from the FORECAST (temp still below threshold) with full zero-touch explanation', async () => {
  const seq = [...Array(6).fill(16), ...Array.from({ length: 11 }, (_, i) => 16.5 + i * 0.5)].map((t, i) => ({ t, nfc: i === 5 }));
  const app = scripted(seq); app.store.patch({ cardState: 'manifested' });
  const alerts = []; app.bus.on('alert:accepted', (a) => alerts.push(a));
  for (let i = 0; i < seq.length; i++) await app.runMonitoringCycle();
  const a = alerts.find((x) => x.type === 'TEMP_PREDICTED');
  assert.ok(a, 'predictive alert expected: ' + JSON.stringify(alerts.map((x) => x.type)));
  assert.ok(a.data_payload.value < 22, 'current value is below the threshold');
  assert.deepEqual(a.causality_chain.map((c) => c.kind), ['nfc_detected', 'temp_rising']);
  assert.match(a.explanation, /NFC tag was detected/); assert.match(a.explanation, /rising/); assert.match(a.explanation, /breached in \d+ cycle/);
  assert.equal(a.predicted_state, 'WARMING'); assert.ok(a.confidence_score > 0 && a.confidence_score <= 1);
});

test('PHASE 3: a low-confidence alert emits a MetaEvent that lowers FirewallService trust', () => {
  const app = mk(1, { rng: () => 0.5 }); const events = []; app.bus.on('meta:event', (e) => events.push(e));
  const data = { isStreaming: true, timestamp: app.now() };
  const before = app.firewall.trustScore(data, 'OK');
  const ev = app.meta.reviewAlert({ id: 'x', confidence_score: 0.2 });
  assert.equal(ev.kind, 'LOW_CONFIDENCE_ALERT'); assert.equal(events.length, 1);
  assert.ok(app.firewall.trustScore(data, 'OK') < before);
  assert.equal(app.meta.reviewAlert({ id: 'y', confidence_score: 0.9 }), null);
});

test('metacognition widens intervals when coverage is poor and raises escalation margin on false claims', () => {
  const bus = new EventBus(); const g = new GraphService(); const m = new MetacognitiveService({ bus, graph: g });
  for (let c = 1; c <= 20; c++) m.observe({ temperatureC: 30 }, { cycle: c, ready: true, horizons: [{ h: 1, targetCycle: c + 1, predicted: 20, low: 19, high: 21, confidence: 0.9 }] }, 'OK', { topCause: 'bleActivity' });
  assert.ok(m.intervalScale > 1.2); assert.ok(m.adjustments().confidenceScale < 0.5);
  m.registerClaim({ threshold: 22, byCycle: 1 }); m.observe({ temperatureC: 10 }, { cycle: 5, ready: false, horizons: [] }, 'OK', null);
  assert.ok(m.escalationMargin >= 0.5);
});

test('Holt predictor: rising ramp gives finite time-to-threshold and ordered horizons', () => {
  const h = new HorizonPredictor(); let f; for (let i = 0; i < 8; i++) f = h.observe({ temperatureC: 14 + i });
  assert.ok(f.ready && f.slope > 0.9 && f.slope < 1.1); assert.ok(f.ttcCycles > 0 && f.ttcCycles < 2.5);
  assert.ok(f.horizons[2].predicted > f.horizons[0].predicted);
  let flat; const h2 = new HorizonPredictor(); for (let i = 0; i < 8; i++) flat = h2.observe({ temperatureC: 18 + (i % 2) * 0.1 });
  assert.equal(flat.ttcCycles, null);
});

test('action gate: sensitive/IMMEDIATE actions blocked unless human confirms (strict true); kill switch; allow-list; the card must acknowledge', async () => {
  const acknowledge = async () => ({ acknowledged: true });
  for (const [confirm, ok] of [[async () => false, false], [async () => 'yes', false], [async () => true, true]]) {
    const app = mk(7, { confirm, rng: () => 0.5, commandBridge: acknowledge });
    app.store.patch({ cardState: 'manifested', lastSample: { temperatureC: 40 } });
    const r = await app.actions.sendAction({ type: 'TEMP_CRITICAL', recommendation: 'IMMEDIATE ACTION: Shut down system!', action: 'SHUTDOWN' });
    assert.equal(r.ok, ok);
  }
  const a = mk(7, { rng: () => 0.5 }); a.store.patch({ lastSample: { temperatureC: 30 }, isPoweredOff: true });
  assert.equal((await a.actions.sendAction({ action: 'MONITOR', recommendation: 'x' })).reason, 'KILL_SWITCH_ENGAGED');
  const b = mk(7, { rng: () => 0.5 }); b.store.patch({ lastSample: { temperatureC: 30 } });
  assert.equal((await b.actions.sendAction({ action: 'FORMAT_DISK', recommendation: 'x' })).reason, 'ACTION_NOT_ALLOWED');

  // Without a card command channel, an action that needs the card fails instead of pretending to succeed.
  const c = mk(7, { confirm: async () => true, rng: () => 0.5 }); c.store.patch({ cardState: 'manifested', lastSample: { temperatureC: 40 } });
  const blocked = await c.actions.sendAction({ type: 'TEMP_CRITICAL', recommendation: 'Run Cooling Diagnostic.', action: 'RUN_COOLING_DIAGNOSTIC' });
  assert.equal(blocked.ok, false); assert.equal(blocked.reason, 'NO_CARD_COMMAND_CAPABILITY');
  // Local-only actions still work without a card command channel and report that nothing was sent to the card.
  const local = await c.actions.sendAction({ action: 'LOG', recommendation: 'x' });
  assert.equal(local.ok, true); assert.equal(local.sentToCard, false);
  // A card that does not acknowledge the command is a failure.
  const d = mk(7, { rng: () => 0.5, commandBridge: async () => ({ acknowledged: false }) }); d.store.patch({ lastSample: { temperatureC: 30 } });
  assert.equal((await d.actions.sendAction({ action: 'RESTART_MODULE', recommendation: 'x' })).reason, 'CARD_DID_NOT_ACKNOWLEDGE');
});

test('a device that returns after being lost is read again (no stuck lost state)', async () => {
  let present = true;
  class Flaky extends TelemetryEngine {
    constructor(now) { super({ detectDelayMs: 0, now, rng: () => 0.5 }); }
    async detectDevice() { return present; }
  }
  let c = 1e6; const now = () => (c += 1);
  const app = new SentinelConsole({ now, telemetry: new Flaky(now), storage: null });
  await app.runMonitoringCycle(); assert.equal(app.store.get().cardState, 'manifested');
  present = false; await app.runMonitoringCycle(); assert.equal(app.store.get().cardState, 'lost');
  present = true; await app.runMonitoringCycle(); assert.equal(app.store.get().cardState, 'manifested');
});

test('loop never overlaps cycles; UIRenderer is inert without a DOM', async () => {
  const timers = []; const app = mk(3, { setTimer: (f) => { timers.push(f); return timers.length; }, clearTimer: () => {} });
  new UIRenderer({ doc: null, bus: app.bus }); app.store.patch({ cardState: 'manifested' });
  app.startMonitoringLoop(); app.startMonitoringLoop();
  await new Promise((r) => setTimeout(r, 20)); assert.equal(timers.length, 1); app.stopMonitoringLoop();
});
