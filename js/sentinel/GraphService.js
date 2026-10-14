import { clamp, mean, std, pearson } from './stats.js';

const NODES = ['temp', 'battery', 'bleActivity', 'nfcActivity', 'quality'];
const PRIORS = { 'battery->temp': -0.2, 'bleActivity->temp': 0.3, 'nfcActivity->temp': 0.3, 'quality->temp': 0.1 };
const WINDOW = 40;
const EVENT_RULES = {
  nfc_detected: ['temp_rising'],
  ble_new: ['temp_rising'],
  temp_rising: ['threshold_predicted', 'threshold_crossed'],
  threshold_predicted: ['threshold_crossed']
};
const LOOKBACK_CYCLES = 8;

export class GraphService {
  constructor() {
    this.series = Object.fromEntries(NODES.map((n) => [n, []]));
    this.edges = {};
    for (const a of NODES) for (const b of NODES) {
      if (a !== b) this.edges[`${a}->${b}`] = { from: a, to: b, prior: PRIORS[`${a}->${b}`] ?? 0, learned: 0, feedback: 1, weight: 0 };
    }
    this.events = new Map();
    this.order = [];
  }

  observe(sample) {
    if (!Number.isFinite(sample.temperatureC) || sample.temperatureC === 0) return;
    const values = { temp: sample.temperatureC, battery: sample.batteryPct ?? 0, bleActivity: sample.ble ? 1 : 0, nfcActivity: sample.nfc ? 1 : 0, quality: sample.isStreaming ? 1 : 0 };
    for (const n of NODES) { this.series[n].push(values[n]); if (this.series[n].length > WINDOW) this.series[n].shift(); }
    if (this.series.temp.length < 10) return;
    for (const edge of Object.values(this.edges)) {
      const r = pearson(this.series[edge.from].slice(0, -1), this.series[edge.to].slice(1));
      edge.learned = 0.7 * edge.learned + 0.3 * r;
      edge.weight = clamp((0.3 * edge.prior + 0.7 * edge.learned) * edge.feedback, -1, 1);
    }
  }

  linkEvent({ id, kind, cycle }) {
    const causes = this.order
      .map((eid) => this.events.get(eid))
      .filter((e) => e && cycle - (e.lastCycle ?? e.cycle) <= LOOKBACK_CYCLES && cycle >= e.cycle && (EVENT_RULES[e.kind] ?? []).includes(kind))
      .sort((a, b) => b.cycle - a.cycle)
      .map((e) => e.id);
    this.events.set(id, { id, kind, cycle, causes });
    this.order.push(id);
    if (this.order.length > 200) this.events.delete(this.order.shift());
    return this.events.get(id);
  }

  touchEvent(id, cycle) {
    const e = this.events.get(id);
    if (e) e.lastCycle = cycle;
  }

  causalityChain(id) {
    const node = this.events.get(id);
    if (!node) return [];
    const chain = [], seen = new Set([id]);
    let frontier = node.causes.slice(0, 1);
    while (frontier.length) {
      const next = [];
      for (const cid of frontier) {
        const e = this.events.get(cid);
        if (!e || seen.has(cid)) continue;
        seen.add(cid);
        chain.unshift({ id: e.id, kind: e.kind, cyclesAgo: node.cycle - e.cycle });
        next.push(...e.causes.slice(0, 1));
      }
      frontier = next;
    }
    return chain;
  }

  explain(target = 'temp') {
    const causes = Object.values(this.edges)
      .filter((e) => e.to === target && Math.abs(e.weight) >= 0.25)
      .map((e) => {
        const s = this.series[e.from];
        const z = std(s) ? (s[s.length - 1] - mean(s)) / std(s) : 0;
        return { from: e.from, weight: Number(e.weight.toFixed(3)), z: Number(z.toFixed(2)), contribution: Number((e.weight * z).toFixed(3)) };
      })
      .sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
    const top = causes[0] ?? null;
    return {
      target,
      causes,
      topCause: top ? top.from : null,
      confidence: clamp(causes.reduce((s, c) => s + Math.abs(c.contribution), 0) / 2, 0, 1),
      summary: top ? `${target} movement is most associated with ${top.from} (weight ${top.weight}, z=${top.z}).` : 'No significant upstream cause found; likely ambient or environmental.'
    };
  }

  applyFeedback(topCause, hit) {
    const edge = topCause ? this.edges[`${topCause}->temp`] : null;
    if (edge) edge.feedback = clamp(edge.feedback * (hit ? 1.02 : 0.95), 0.3, 1.5);
  }

  toJSON() { return { edges: this.edges }; }
}
