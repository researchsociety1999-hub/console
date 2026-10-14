import { clamp } from './stats.js';

const PRIOR_WEIGHT = 10;

export class MetacognitiveService {
  constructor({ bus, graph }) {
    this.bus = bus;
    this.graph = graph;
    this.pending = [];
    this.claims = [];
    this.resolved = [];
    this.reliability = 1;
    this.intervalScale = 1;
    this.escalationMargin = 0;
    this.falseClaims = 0;
    this.totalClaims = 0;
    this.trustPenalty = 0;
    this.metaEvents = [];
  }

  reviewAlert(alert, lowThreshold = 0.5) {
    if (!alert || alert.confidence_score >= lowThreshold) return null;
    const penalty = Math.min(0.3, 0.05 + (lowThreshold - alert.confidence_score) * 0.3);
    this.trustPenalty = Math.min(0.3, this.trustPenalty + penalty);
    const metaEvent = { kind: 'LOW_CONFIDENCE_ALERT', alertId: alert.id, confidence: alert.confidence_score, penalty, trustPenalty: this.trustPenalty };
    this.metaEvents.push(metaEvent);
    if (this.metaEvents.length > 50) this.metaEvents.shift();
    this.bus.emit('meta:event', metaEvent);
    return metaEvent;
  }

  adjustments() {
    const n = this.resolved.length;
    const hits = this.resolved.filter((r) => r.hit).length;
    const coverage = (hits + 0.95 * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT);
    return {
      intervalScale: this.intervalScale,
      confidenceScale: clamp(coverage / 0.95, 0.3, 1),
      trustScale: (0.7 + 0.3 * this.reliability) * (1 - this.trustPenalty),
      escalationMargin: this.escalationMargin,
      coverage
    };
  }

  observe(sample, forecast, status, explanation) {
    this.reliability = 0.9 * this.reliability + 0.1 * (status === 'OK' ? 1 : 0);
    this.trustPenalty *= 0.9;
    const temp = Number.isFinite(sample.temperatureC) && sample.temperatureC !== 0 ? sample.temperatureC : null;
    if (temp !== null) this.resolvePredictions(temp, forecast.cycle);
    this.resolveClaims(temp, forecast.cycle);
    if (forecast.ready) {
      for (const h of forecast.horizons) this.pending.push({ ...h, cause: explanation?.topCause ?? null });
      if (this.pending.length > 90) this.pending.splice(0, this.pending.length - 90);
    }
  }

  resolvePredictions(actual, cycle) {
    const due = this.pending.filter((p) => p.targetCycle <= cycle);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.targetCycle > cycle);
    for (const p of due) {
      const hit = actual >= p.low && actual <= p.high;
      this.resolved.push({ h: p.h, error: Math.abs(actual - p.predicted), hit });
      this.graph.applyFeedback(p.cause, hit);
    }
    if (this.resolved.length > 40) this.resolved.splice(0, this.resolved.length - 40);
    const coverage = this.resolved.filter((r) => r.hit).length / this.resolved.length;
    if (this.resolved.length >= 8) {
      if (coverage < 0.85) this.intervalScale = Math.min(3, this.intervalScale * 1.1);
      else if (coverage > 0.99) this.intervalScale = Math.max(0.7, this.intervalScale * 0.95);
    }
    this.bus.emit('meta:updated', { ...this.adjustments(), resolved: this.resolved.length });
  }

  registerClaim({ threshold, byCycle }) {
    this.claims.push({ threshold, byCycle, crossed: false });
    this.totalClaims += 1;
  }

  resolveClaims(temp, cycle) {
    for (const c of this.claims) if (!c.crossed && temp !== null && temp >= c.threshold) c.crossed = true;
    const done = this.claims.filter((c) => c.crossed || cycle > c.byCycle);
    if (!done.length) return;
    this.claims = this.claims.filter((c) => !done.includes(c));
    for (const c of done) {
      if (!c.crossed) this.falseClaims += 1;
      this.escalationMargin = clamp(this.escalationMargin + (c.crossed ? -0.25 : 0.5), 0, 3);
    }
  }

  toJSON() { return { trustPenalty: this.trustPenalty, reliability: this.reliability, intervalScale: this.intervalScale, escalationMargin: this.escalationMargin }; }
}
