import { CFG } from './constants.js';
import { clamp } from './stats.js';

const ALPHA = 0.7;
const BETA = 0.5;
const MAX_TTC_CYCLES = 100;
const MIN_TREND = 0.05;

export class HorizonPredictor {
  constructor({ getAdjustments = () => ({ intervalScale: 1, confidenceScale: 1 }) } = {}) {
    this.getAdjustments = getAdjustments;
    this.cycle = 0;
    this.n = 0;
    this.level = null;
    this.trend = 0;
    this.sigma2 = 0.0225;
    this.diffs = [];
    this.last = null;
  }

  observe(sample) {
    this.cycle += 1;
    const y = sample.temperatureC;
    if (Number.isFinite(y) && y !== 0) {
      if (this.level === null) {
        this.level = y;
      } else {
        const expected = this.level + this.trend;
        const err = y - expected;
        this.sigma2 = 0.8 * this.sigma2 + 0.2 * err * err;
        const prevLevel = this.level;
        this.level = ALPHA * y + (1 - ALPHA) * expected;
        this.trend = this.n === 1 ? y - this.last : BETA * (this.level - prevLevel) + (1 - BETA) * this.trend;
        this.diffs.push(y - this.last);
        if (this.diffs.length > 5) this.diffs.shift();
      }
      this.last = y;
      this.n += 1;
    }
    return this.predict();
  }

  predict() {
    const base = { cycle: this.cycle, n: this.n, ready: false, horizons: [], ttcCycles: null, ttcSeconds: null, slope: this.trend, sigma: Math.sqrt(this.sigma2), method: 'holt' };
    if (this.n < 4) return base;
    const sigma = Math.max(Math.sqrt(this.sigma2), 0.15);
    const adj = this.getAdjustments();
    const moving = this.diffs.filter((d) => Math.abs(d) >= 0.05);
    const agree = moving.length ? moving.filter((d) => Math.sign(d) === Math.sign(this.trend)).length / moving.length : 0;
    const horizons = CFG.HORIZONS.map((h) => {
      const predicted = this.level + h * this.trend;
      const varH = sigma ** 2 * (1 + (h - 1) * (ALPHA ** 2 + ALPHA * BETA * h + (BETA ** 2 * h * (2 * h - 1)) / 6));
      const se = Math.sqrt(varH);
      const half = 1.96 * se * adj.intervalScale;
      const signal = Math.abs(this.trend) * h;
      const confidence = clamp((signal / (signal + se)) * agree * adj.confidenceScale, 0, 1);
      return { h, targetCycle: this.cycle + h, predicted, low: predicted - half, high: predicted + half, confidence };
    });
    const rawTtc = this.trend > MIN_TREND && this.level < CFG.TEMP_CRITICAL_C ? (CFG.TEMP_CRITICAL_C - this.level) / this.trend : null;
    const ttcCycles = rawTtc !== null && rawTtc <= MAX_TTC_CYCLES ? rawTtc : null;
    return { ...base, ready: true, sigma, horizons, ttcCycles, ttcSeconds: ttcCycles === null ? null : ttcCycles * (CFG.WATCHDOG_INTERVAL_MS / 1000) };
  }
}
