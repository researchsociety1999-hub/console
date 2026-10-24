import { CFG } from './constants.js';
import { clamp, mean } from './stats.js';

/**
 * Holt (level + trend) forecaster for ONE numeric metric, using the real sample timestamps so
 * irregular push intervals are handled. Nothing here knows which metrics the card sends: the
 * metric key, direction, threshold and look-ahead come from the `metrics` config you provide.
 */

const ALPHA = 0.6;
const BETA = 0.4;
const MIN_POINTS = 6;

export function validateMetricConfig(config) {
  if (!config || typeof config.key !== 'string' || !config.key) throw new Error('Metric config needs a key naming the sample field to watch.');
  if (config.direction !== 'above' && config.direction !== 'below') throw new Error(`Metric "${config.key}" direction must be "above" or "below".`);
  if (!Number.isFinite(config.threshold)) throw new Error(`Metric "${config.key}" needs a numeric threshold.`);
  if (!Number.isFinite(config.horizonSeconds) || config.horizonSeconds <= 0) throw new Error(`Metric "${config.key}" needs a positive horizonSeconds.`);
}

export class MetricForecaster {
  constructor(config) {
    validateMetricConfig(config);
    this.config = config;
    this.level = null;
    this.trend = 0; // units per second
    this.lastT = null;
    this.lastY = null;
    this.n = 0;
    this.sigma2 = 0;
    this.diffs = [];
    this.dts = [];
    this.hits = [];
  }

  floor() {
    return Math.max(1e-9, 0.005 * Math.abs(this.level ?? 0));
  }

  coverage() {
    return this.hits.length >= 8 ? this.hits.reduce((a, b) => a + b, 0) / this.hits.length : null;
  }

  observe(timestampMs, value) {
    if (!Number.isFinite(timestampMs) || !Number.isFinite(value)) return this.predict();
    if (this.lastT !== null && timestampMs <= this.lastT) return this.predict(); // duplicate or out-of-order
    if (this.level === null) {
      this.level = value;
      this.lastT = timestampMs;
      this.lastY = value;
      this.n = 1;
      return this.predict();
    }

    const dt = (timestampMs - this.lastT) / 1000;
    const expected = this.level + this.trend * dt;
    const err = value - expected;

    if (this.n >= 2) {
      // Self-check: did the previous one-step forecast contain this observation?
      const half = 1.96 * Math.max(Math.sqrt(this.sigma2), this.floor());
      this.hits.push(Math.abs(err) <= half ? 1 : 0);
      if (this.hits.length > 30) this.hits.shift();
    }

    this.sigma2 = this.n === 1 ? err * err : 0.8 * this.sigma2 + 0.2 * err * err;
    const previousLevel = this.level;
    this.level = ALPHA * value + (1 - ALPHA) * expected;
    this.trend = this.n === 1 ? (value - this.lastY) / dt : BETA * ((this.level - previousLevel) / dt) + (1 - BETA) * this.trend;

    this.diffs.push(value - this.lastY);
    if (this.diffs.length > 5) this.diffs.shift();
    this.dts.push(dt);
    if (this.dts.length > 10) this.dts.shift();

    this.lastT = timestampMs;
    this.lastY = value;
    this.n += 1;
    return this.predict();
  }

  predict() {
    const { key, label, unit, direction, threshold, horizonSeconds, minConfidence } = this.config;
    const base = {
      key,
      label: label ?? key,
      unit: unit ?? '',
      direction,
      threshold,
      horizonSeconds,
      minConfidence: minConfidence ?? CFG.PREDICT_CONFIDENCE_MIN,
      ready: false,
      n: this.n,
      level: this.level,
      slopePerSecond: this.trend,
      ttcSeconds: null,
      crossed: false,
      confidence: 0,
      coverage: this.coverage()
    };
    if (this.n < MIN_POINTS) return base;

    const remaining = direction === 'below' ? this.level - threshold : threshold - this.level;
    if (remaining <= 0) return { ...base, ready: true, crossed: true, ttcSeconds: 0, confidence: 1 }; // observed, not forecast

    const speed = direction === 'below' ? -this.trend : this.trend; // positive when heading toward the threshold
    const sigma = Math.max(Math.sqrt(this.sigma2), this.floor());
    if (speed <= 0 || speed * horizonSeconds < 2 * sigma) return { ...base, ready: true }; // not moving toward it faster than the noise

    const ttc = remaining / speed;
    if (ttc > horizonSeconds) return { ...base, ready: true }; // too far ahead to claim anything

    const averageDt = mean(this.dts) || 1;
    const signal = remaining;
    const standardError = sigma * Math.sqrt(1 + ttc / averageDt);
    const moving = this.diffs.filter((d) => d !== 0);
    const agree = moving.length ? moving.filter((d) => Math.sign(d) === Math.sign(this.trend)).length / moving.length : 0;
    const coverage = base.coverage;
    const coverageScale = coverage === null ? 0.7 : clamp(coverage / 0.95, 0.3, 1);
    const confidence = clamp((signal / (signal + standardError)) * agree * coverageScale, 0, 1);
    return { ...base, ready: true, ttcSeconds: ttc, confidence };
  }
}
