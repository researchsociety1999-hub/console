import { describe, expect, it } from 'vitest';
import { MetricForecaster } from '../js/sentinel/MetricForecaster.js';

// Made-up numbers for testing the maths only; they say nothing about the real card.
const config = { key: 'level', label: 'Level', unit: '%', direction: 'below', threshold: 20, horizonSeconds: 600 };
const feed = (forecaster, values, stepMs = 10000, start = 0) => {
  let result;
  values.forEach((value, i) => { result = forecaster.observe(start + i * stepMs, value); });
  return result;
};

describe('MetricForecaster', () => {
  it('requires a complete config', () => {
    expect(() => new MetricForecaster({})).toThrow(/key/);
    expect(() => new MetricForecaster({ ...config, direction: 'sideways' })).toThrow(/direction/);
    expect(() => new MetricForecaster({ ...config, threshold: 'x' })).toThrow(/threshold/);
    expect(() => new MetricForecaster({ ...config, horizonSeconds: 0 })).toThrow(/horizonSeconds/);
  });

  it('is not ready until it has enough points', () => {
    const result = feed(new MetricForecaster(config), [50, 49, 48]);
    expect(result.ready).toBe(false);
    expect(result.ttcSeconds).toBeNull();
  });

  it('forecasts the time to a falling threshold with a usable confidence', () => {
    const result = feed(new MetricForecaster(config), Array.from({ length: 14 }, (_, i) => 50 - i));
    expect(result.ready).toBe(true);
    expect(result.crossed).toBe(false);
    expect(result.ttcSeconds).toBeGreaterThan(100);
    expect(result.ttcSeconds).toBeLessThan(250);
    expect(result.confidence).toBeGreaterThan(0.6);
  });

  it('makes no forecast for a flat series', () => {
    const result = feed(new MetricForecaster(config), Array(14).fill(50));
    expect(result.ready).toBe(true);
    expect(result.ttcSeconds).toBeNull();
  });

  it('makes no forecast when the metric moves away from the threshold', () => {
    const result = feed(new MetricForecaster(config), Array.from({ length: 14 }, (_, i) => 30 + i));
    expect(result.ttcSeconds).toBeNull();
  });

  it('makes no claim beyond the look-ahead window', () => {
    const result = feed(new MetricForecaster(config), Array.from({ length: 14 }, (_, i) => 50 - i * 0.01));
    expect(result.ttcSeconds).toBeNull();
  });

  it('reports an observed crossing', () => {
    const result = feed(new MetricForecaster(config), Array.from({ length: 10 }, (_, i) => 24 - i));
    expect(result.crossed).toBe(true);
    expect(result.ttcSeconds).toBe(0);
  });

  it('works for a metric that must stay below a limit', () => {
    const result = feed(new MetricForecaster({ ...config, direction: 'above', threshold: 80 }), Array.from({ length: 14 }, (_, i) => 40 + i));
    expect(result.ttcSeconds).toBeGreaterThan(100);
    expect(result.ttcSeconds).toBeLessThan(600);
  });

  it('ignores duplicate, out-of-order and non-finite observations', () => {
    const forecaster = new MetricForecaster(config);
    forecaster.observe(2000, 50);
    forecaster.observe(1000, 10);
    forecaster.observe(2000, 10);
    forecaster.observe(3000, Number.NaN);
    expect(forecaster.n).toBe(1);
  });
});
