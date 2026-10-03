import { describe, it, expect } from 'vitest';
import * as P from '../js/async-pipeline.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const good = JSON.stringify({ ai_narrative: 'a', suggested_severity: 'high', final_action_type: 'lockdown', refined_prediction: 'p', recommendation_text: 'r', root_cause_summary: 'c' });

describe('async monitoring pipeline', () => {
  it('keeps the queue bounded, publish non-blocking, and handler errors isolated', async () => {
    const q = new P.AsyncEventQueue({ maxSize: 32 });
    const seen = [];
    q.subscribe(async (e) => { if (e === 1) throw new Error('x'); await sleep(0); seen.push(e); });
    for (let i = 0; i < 50; i++) q.publish(i);
    await q.flush();
    expect(q.dropped).toBe(18);
    expect(seen.length).toBeLessThanOrEqual(32);
  });

  it('computes contextual features', () => {
    const f = P.generateContextualFeatures({ thermal: 42, ble: { newDeviceId: 'x' } }, [{ thermal: 30 }, { thermal: 35 }]);
    expect(f.delta_temp).toBe(7);
    expect(f.temp_trend).toBe('rising');
    expect(f.novelty_detected).toBe(true);
    expect(f.critical_threshold_crossed).toBe(true);
    expect(P.generateContextualFeatures({ thermal: 20 }, []).temp_trend).toBe('stable');
  });

  it('validates reasoning output and falls back on malformed output, timeout, or missing model', async () => {
    const a = { id: 1, severity: 'HIGH' };
    expect((await P.enrichAlertWithLocalReasoning(a, {}, { complete: async () => 'noise ' + good })).final_action_type).toBe('LOCKDOWN');
    expect((await P.enrichAlertWithLocalReasoning(a, {}, { complete: async () => 'nope' })).source).toBe('fallback');
    const t0 = Date.now();
    const r = await P.enrichAlertWithLocalReasoning(a, {}, { complete: () => new Promise(() => {}), timeoutMs: 50 });
    expect(r.source).toBe('fallback');
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await P.enrichAlertWithLocalReasoning(a, {}, {})).final_action_type).toBe('MONITOR');
  });

  it('enforces allow-list, authorization, packet validation, and human confirmation in order', async () => {
    const calls = [];
    const base = { validatePacket: () => true, isAuthorized: () => true, execute: async (a) => { calls.push(a); return 'ok'; }, audit: async () => {} };
    const al = { id: 1 };
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'FORMAT_DISK' }, base)).status).toBe('BLOCKED_NOT_ALLOWLISTED');
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'MONITOR' }, { ...base, isAuthorized: () => false })).status).toBe('BLOCKED_UNAUTHORIZED');
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'MONITOR' }, { ...base, validatePacket: () => false })).status).toBe('BLOCKED_INVALID_PACKET');
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'ZEROIZE' }, base)).status).toBe('CONFIRMATION_REQUIRED');
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'ZEROIZE' }, { ...base, requestConfirmation: async () => false })).status).toBe('DENIED_BY_HUMAN');
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'ZEROIZE' }, { ...base, requestConfirmation: async () => 'yes' })).status).toBe('DENIED_BY_HUMAN');
    expect(calls).toEqual([]);
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'LOCKDOWN' }, { ...base, requestConfirmation: async () => true })).status).toBe('EXECUTED');
    expect((await P.dispatchOnlyAllowedRecommendation(al, { final_action_type: 'MONITOR' }, base)).status).toBe('EXECUTED');
  });

  it('publishes telemetry without waiting for a hung LLM', async () => {
    const tele = [];
    const reas = [];
    const p = P.createMonitoringPipeline({
      publishTelemetry: (x) => tele.push(x),
      publishReasoning: (x) => reas.push(x),
      detectAlert: (s) => (s.thermal > 40 ? { id: s.thermal, severity: 'CRITICAL' } : null),
      complete: () => new Promise(() => {}),
      dispatchDeps: {}
    });
    p.sampleIn({ thermal: 45 });
    p.sampleIn({ thermal: 30 });
    await p.queue.flush();
    expect(tele.length).toBe(2);
    expect(reas.length).toBe(0);
  });
});
