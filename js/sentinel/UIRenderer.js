export class UIRenderer {
  constructor({ doc = globalThis.document, bus, raf = globalThis.requestAnimationFrame?.bind(globalThis) } = {}) {
    this.doc = doc;
    this.raf = raf;
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
    root.classList.toggle('state-manifested', state.cardState === 'manifested');
    root.classList.toggle('critical-leak', Boolean(alert?.isCriticalLeak));
    this.set('device-status', `Status: ${alert?.integrityStatus ?? (state.cardState === 'lost' ? 'Ghost' : 'OK')}`);
    if (sample && Number.isFinite(sample.temperatureC)) this.animateNumberTo('primaryReading', sample.temperatureC);
    else this.set('primaryReading', '--');
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
    const ghost = this.el('ghost-listen');
    if (ghost) ghost.style.display = state.cardState === 'lost' ? 'flex' : 'none';
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
