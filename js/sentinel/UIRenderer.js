const ACTION_LABELS = {
  MONITOR: 'Keep monitoring',
  LOG: 'Log this',
  FLAG_FOR_REVIEW: 'Flag for review',
  RUN_COOLING_DIAGNOSTIC: 'Run diagnostic',
  RESTART_MODULE: 'Restart module',
  SHUTDOWN: 'Shut down'
};

const SEVERITY_LEVELS = ['critical', 'high', 'medium', 'low'];
const LOW_TRUST = 0.5; // below this the main card shows a caution shimmer

export class UIRenderer {
  constructor({ doc = globalThis.document, bus, raf = globalThis.requestAnimationFrame?.bind(globalThis), primaryMetric = null } = {}) {
    this.doc = doc;
    this.raf = raf;
    this.primaryMetric = primaryMetric;
    this.soundEnabled = false; // the alert tone is the browser's speaker, never the card's buzzer, and is opt-in
    if (!doc) return;
    bus.on('state:changed', (state) => this.render(state));
    bus.on('firewall:stage', ({ stage }) => this.pulse(stage));
    bus.on('feedback:buzzer', ({ freq, duration }) => this.beep(freq, duration));
  }

  el(id) { return this.doc?.getElementById(id) ?? null; }

  set(id, text) { const e = this.el(id); if (e) e.textContent = text; }

  render(state) {
    const alert = state.lastAlert;
    const sample = state.lastSample;
    const root = this.doc.body;
    root.classList.toggle('state-lost', state.cardState === 'lost');
    root.classList.toggle('state-ghost', state.cardState === 'ghost');
    root.classList.toggle('state-manifested', state.cardState === 'manifested');
    root.classList.toggle('critical-leak', Boolean(alert?.isCriticalLeak));
    this.set('device-status', `Status: ${alert?.integrityStatus ?? (state.cardState === 'lost' ? 'Ghost' : 'OK')}`);

    const metric = this.primaryMetric;
    if (metric) {
      const value = sample?.[metric.key];
      this.set('primaryLabel', metric.label ?? metric.key);
      this.set('primaryUnit', Number.isFinite(value) ? (metric.unit ?? '') : '');
      if (Number.isFinite(value)) this.animateNumberTo('primaryReading', value);
      else this.set('primaryReading', '--');
    } else if (sample && Number.isFinite(sample.temperatureC)) {
      this.animateNumberTo('primaryReading', sample.temperatureC);
    } else {
      this.set('primaryReading', '--');
    }

    const msg = this.el('alertMessage');
    if (msg) { msg.textContent = alert?.message ?? ''; msg.className = `alert-badge ${(alert?.severity ?? '').toLowerCase()}`.trim(); }
    const arrow = this.el('trendArrow');
    if (arrow) arrow.className = `trend-arrow ${sample?.trend ?? 'stable'}`;
    const badge = this.el('predictedStateBadgeText');
    if (badge) {
      badge.textContent = alert?.predicted_state ?? 'NOMINAL';
      const color = alert?.predicted_state === 'CRITICAL' ? 'var(--red)' : alert?.predicted_state === 'HIGH_TEMP_STABLE' ? 'var(--amber)' : 'var(--cyan)';
      badge.style.color = color;
      badge.style.borderColor = color;
    }
    this.set('alertExplanation', alert?.explanation ?? '');
    this.set('confidenceScore', alert ? `${Math.round((alert.confidence_score ?? 0) * 100)}%` : '');

    const chain = Array.isArray(alert?.causality_chain) ? alert.causality_chain : [];
    this.set('alertChain', chain.map((c) => `${String(c.kind).replace(/_/g, ' ')} (${c.cyclesAgo} cycle(s) earlier, ${c.relation ?? 'co-occurred'})`).join(' \u2192 '));
    const forecast = Number.isFinite(alert?.ttcSeconds) ? `Forecast: ~${Math.round(alert.ttcSeconds)}s to threshold` : '';
    const forecastConfidence = Number.isFinite(alert?.forecastConfidence) ? ` (confidence ${Math.round(alert.forecastConfidence * 100)}%)` : '';
    this.set('alertForecast', forecast ? forecast + forecastConfidence : '');
    const age = Number.isFinite(sample?.timestamp) ? Math.max(0, Math.round((Date.now() - sample.timestamp) / 1000)) : null;
    this.set('freshnessTag', age === null ? '' : age < 2 ? 'Last update: just now' : `Last update: ${age}s ago`);
    this.set('dataQualityTag', sample ? `Data quality: ${alert?.integrityStatus ?? 'OK'}` : '');

    // Alert lifecycle, trust and actions
    const alertState = alert ? (alert.state ?? 'ACTIVE') : '';
    this.set('alertState', alertState);
    const card = this.el('alertCard');
    if (card?.setAttribute) {
      card.setAttribute('data-state', alert ? alertState : 'none');
      card.setAttribute('data-severity', (alert?.severity ?? 'none').toLowerCase());
    }
    const severity = (alert?.severity ?? '').toLowerCase();
    if (card?.classList) {
      for (const level of SEVERITY_LEVELS) card.classList.toggle(`border-${level}`, level === severity);
    }

    const trust = state.context?.trust;
    this.set('trustBadge', Number.isFinite(trust) ? `Trust ${Math.round(trust * 100)}%` : '');
    const mainCard = this.el('mainCard');
    // Low trust is shown as a caution shimmer. High trust gets no decoration: it has to be earned by the data, not displayed as a reward.
    if (mainCard?.classList) mainCard.classList.toggle('trust-shimmer', Number.isFinite(trust) && trust < LOW_TRUST);

    this.set('rootCause', alert && !alert.metric ? (alert.rootCause?.summary ?? '') : '');
    const ack = this.el('ackButton');
    if (ack) ack.disabled = !alert || alertState === 'ACKNOWLEDGED' || alertState === 'RESOLVED';
    const action = this.el('actionButton');
    if (action) {
      action.textContent = alert ? (ACTION_LABELS[alert.action] ?? alert.action ?? 'Action') : 'No action';
      action.disabled = !alert || alertState === 'RESOLVED';
    }

    const ghost = this.el('ghost-listen');
    if (ghost) ghost.style.display = state.cardState === 'lost' || state.cardState === 'ghost' ? 'flex' : 'none';
  }

  /** Shows the detail card for one alert. Only signal strength is shown for a nearby device; its identity is never displayed. */
  showDetail(alert, sample) {
    const card = this.el('detailCard');
    const body = this.el('detailBody');
    if (!card || !body || !alert) return false;
    const when = Number.isFinite(alert.createdAt) ? new Date(alert.createdAt).toLocaleTimeString() : 'unknown';
    const rows = [
      ['Type', alert.type],
      ['Severity', alert.severity],
      ['State', alert.state ?? 'ACTIVE'],
      ['Raised', when],
      ['Evidence', alert.explanation || alert.message || '']
    ];
    if (Array.isArray(alert.causality_chain) && alert.causality_chain.length) {
      rows.push(['Earlier events', alert.causality_chain.map((c) => `${String(c.kind).replace(/_/g, ' ')} (${c.cyclesAgo} cycle(s) earlier, ${c.relation ?? 'co-occurred'})`).join(' \u2192 ')]);
    }
    if (Number.isFinite(alert.ttcSeconds)) {
      const confidence = Number.isFinite(alert.forecastConfidence) ? `, confidence ${Math.round(alert.forecastConfidence * 100)}%` : '';
      rows.push(['Forecast', `~${Math.round(alert.ttcSeconds)}s to threshold${confidence}`]);
    }
    rows.push(['Confidence', `${Math.round((alert.confidence_score ?? 0) * 100)}%`]);
    rows.push(['Data quality', alert.integrityStatus ?? 'unknown']);
    if (Number.isFinite(sample?.ble?.rssi)) rows.push(['Nearby device signal', `${sample.ble.rssi} dBm`]);
    if (alert.repeatCount) rows.push(['Repeats', String(alert.repeatCount)]);
    rows.push(['Recommendation', alert.recommendation ?? '']);

    this.set('detailTitle', `${alert.type} (${alert.severity})`);
    body.replaceChildren(...rows.map(([key, value]) => {
      const row = this.doc.createElement('div');
      row.className = 'detail-row';
      const keyElement = this.doc.createElement('span');
      keyElement.className = 'detail-key';
      keyElement.textContent = key;
      const valueElement = this.doc.createElement('span');
      valueElement.className = 'detail-value';
      valueElement.textContent = String(value);
      row.append(keyElement, valueElement);
      return row;
    }));
    card.hidden = false;
    return true;
  }

  hideDetail() {
    const card = this.el('detailCard');
    if (card) card.hidden = true;
  }

  pulse(stage) {
    const e = this.doc.querySelector(`.pipeline-stage[data-stage="${stage}"]`);
    if (!e) return;
    e.classList.add('active');
    setTimeout(() => e.classList.remove('active'), 700);
  }

  animateNumberTo(id, target) {
    const e = this.el(id);
    if (!e) return;
    if (!Number.isFinite(target)) { e.textContent = 'N/A'; return; }
    const start = parseFloat(e.textContent) || target;
    if (!this.raf) { e.textContent = target.toFixed(1); return; }
    const t0 = Date.now();
    const step = () => {
      const p = Math.min(1, (Date.now() - t0) / 500);
      e.textContent = (start + (target - start) * (1 - (1 - p) ** 3)).toFixed(1);
      if (p < 1) this.raf(step);
    };
    this.raf(step);
  }

  beep(freq, duration) {
    if (!this.soundEnabled) return;
    try {
      const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx(), osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = freq; gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination); osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, duration);
    } catch { /* audio unavailable */ }
  }
}
