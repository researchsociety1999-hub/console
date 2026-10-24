import { describe, expect, it } from 'vitest';
import { AlertSynthesizer } from '../js/sentinel/AlertSynthesizer.js';
import { UIRenderer } from '../js/sentinel/UIRenderer.js';
import { EventBus } from '../js/sentinel/EventBus.js';

// Made-up values for testing the logic only.
const classList = () => {
  const names = new Set();
  return { names, toggle(name, on) { if (on) names.add(name); else names.delete(name); } };
};
const element = () => ({ textContent: '', className: '', disabled: false, attrs: {}, classList: classList(), setAttribute(key, value) { this.attrs[key] = value; } });

describe('UIRenderer trust and severity styling', () => {
  const setup = () => {
    const elements = Object.fromEntries(['mainCard', 'alertCard', 'trustBadge', 'primaryReading'].map((id) => [id, element()]));
    const doc = { body: { classList: { toggle() {} } }, getElementById: (id) => elements[id] ?? null, querySelector: () => null };
    const bus = new EventBus();
    const renderer = new UIRenderer({ doc, bus, raf: null });
    return { elements, bus, renderer };
  };

  it('shimmers the main card only for low trust and sets the border class from severity', () => {
    const { elements, bus } = setup();
    bus.emit('state:changed', { cardState: 'manifested', lastSample: null, context: { trust: 0.3 }, lastAlert: { severity: 'CRITICAL', state: 'ACTIVE', action: 'LOG' } });
    expect(elements.mainCard.classList.names.has('trust-shimmer')).toBe(true);
    expect(elements.alertCard.classList.names.has('border-critical')).toBe(true);
    expect(elements.alertCard.classList.names.has('border-high')).toBe(false);
    expect(elements.trustBadge.textContent).toBe('Trust 30%');

    bus.emit('state:changed', { cardState: 'manifested', lastSample: null, context: { trust: 0.9 }, lastAlert: { severity: 'LOW', state: 'ACTIVE', action: 'LOG' } });
    expect(elements.mainCard.classList.names.has('trust-shimmer')).toBe(false);
    expect(elements.alertCard.classList.names.has('border-low')).toBe(true);
    expect(elements.alertCard.classList.names.has('border-critical')).toBe(false);
    expect(elements.trustBadge.textContent).toBe('Trust 90%');
  });

  it('clears the trust badge and shimmer when there is no trust value', () => {
    const { elements, bus } = setup();
    bus.emit('state:changed', { cardState: 'lost', lastSample: null, context: { trust: 0.2 }, lastAlert: null });
    bus.emit('state:changed', { cardState: 'lost', lastSample: null, context: null, lastAlert: null });
    expect(elements.trustBadge.textContent).toBe('');
    expect(elements.mainCard.classList.names.has('trust-shimmer')).toBe(false);
  });

  it('shows N/A for a number that is not finite', () => {
    const { elements, renderer } = setup();
    renderer.animateNumberTo('primaryReading', Number.NaN);
    expect(elements.primaryReading.textContent).toBe('N/A');
    renderer.animateNumberTo('primaryReading', 12.34);
    expect(elements.primaryReading.textContent).toBe('12.3');
  });
});

describe('AlertSynthesizer trust handling', () => {
  const synthesizer = new AlertSynthesizer({ now: () => 1000 });
  const sample = { sourceModule: 'CARD', timestamp: 1000, isStreaming: true };
  const context = (trust) => ({ trust, explanation: { confidence: 0 }, forecast: { ready: false }, metricForecasts: [], adjust: { escalationMargin: 0 } });

  it('recommends verifying the sensor when trust is low and the data is degraded', () => {
    const alert = synthesizer.generateAlert(sample, 'DEGRADED', context(0.38));
    expect(alert.type).toBe('MODULE_FAILURE');
    expect(alert.recommendation).toBe('VERIFY SENSOR HEALTH.');
    expect(alert.action).toBe('FLAG_FOR_REVIEW');
  });

  it('keeps the normal recommendation when trust is not low', () => {
    const alert = synthesizer.generateAlert(sample, 'DEGRADED', context(0.5));
    expect(alert.recommendation).toBe('Run CARD diagnostic.');
    expect(alert.action).toBe('RESTART_MODULE');
  });

  it('adds a plain low-confidence note only when confidence is low', () => {
    const low = synthesizer.generateAlert(sample, 'DEGRADED', context(0.38));
    expect(low.confidence_score).toBeLessThan(0.5);
    expect(synthesizer.explain(low, context(0.38), [])).toMatch(/Low confidence: please check this reading yourself\.$/);

    const high = synthesizer.generateAlert(sample, 'DEGRADED', context(1));
    expect(high.confidence_score).toBeGreaterThanOrEqual(0.5);
    expect(synthesizer.explain(high, context(1), [])).not.toMatch(/Low confidence/);
  });
});
