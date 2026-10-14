import { describe, it, expect } from 'vitest';
import { AppController } from '../js/app.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFakeDocument() {
  const elements = new Map();
  const makeElement = (id) => ({
    id,
    textContent: '',
    className: '',
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    prepend(child) { this.children.unshift(child); },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); },
    get childNodes() { return this.children; },
    get lastChild() { return this.children[this.children.length - 1]; },
  });
  return {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement(id));
      return elements.get(id);
    },
    createElement() { return makeElement('created'); },
    documentElement: { style: { setProperty() {} } },
  };
}

async function withDocument(fn) {
  const previous = globalThis.document;
  const fakeDocument = makeFakeDocument();
  globalThis.document = fakeDocument;
  try {
    return await fn(fakeDocument);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
}

function makeApp(overrides = {}) {
  const app = Object.create(AppController.prototype);
  Object.assign(app, {
    adapter: {
      connected: false,
      transport: 'Simulated',
      connect: async () => { app.adapter.connected = true; },
      disconnect: async () => { app.adapter.connected = false; },
      getRadarScanData: () => ({ devices: [] }),
      getGpioSnapshot: () => ({}),
      sample: async () => ({ thermal: 20 }),
    },
    auditFirewall: { authorized: false, sessionClear() {}, logEvent: async () => null },
    localLLM: { unloadSession() {} },
    radarScanner: { render() {} },
    monitoringPipeline: { sampleIn() {} },
    pollTimer: null,
    _polling: false,
    _confirmationTimer: null,
    _pipelineApprovalResolver: null,
    pendingLlmAction: null,
    latestTelemetry: null,
    currentTheme: 'operator',
    ...overrides,
  });
  return app;
}

describe('AppController behaviour fixes', () => {
  it('reports a failed connection instead of throwing, and does not start polling', async () => {
    await withDocument(async (doc) => {
      const app = makeApp();
      app.adapter.connect = async () => { throw new Error('boom'); };
      await app.handleConnect();
      expect(doc.getElementById('predicted-state-badge').textContent).toBe('CONNECTION FAILED');
      expect(doc.getElementById('alert-stream').children.length).toBe(1);
      expect(app.pollTimer).toBe(null);
    });
  });

  it('polls immediately, then every 15 seconds, without overlapping samples', async () => {
    await withDocument(async () => {
      const realSetInterval = globalThis.setInterval;
      const realClearInterval = globalThis.clearInterval;
      let captured = null;
      let cleared = null;
      globalThis.setInterval = (fn, ms) => { captured = { fn, ms }; return 123; };
      globalThis.clearInterval = (id) => { cleared = id; };
      try {
        const samples = [];
        const app = makeApp({ monitoringPipeline: { sampleIn: (s) => samples.push(s) } });
        app.adapter.connected = true;
        app.startPolling();
        await sleep(0);
        expect(captured.ms).toBe(15000);
        expect(samples.length).toBe(1);

        await captured.fn();
        expect(samples.length).toBe(2);

        app._polling = true;
        await captured.fn();
        expect(samples.length).toBe(2);
        app._polling = false;

        app.stopPolling();
        expect(cleared).toBe(123);
        expect(app.pollTimer).toBe(null);
      } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.clearInterval = realClearInterval;
      }
    });
  });

  it('denies an older pending confirmation when a newer one arrives, and approves the newer one', async () => {
    await withDocument(async () => {
      const app = makeApp();
      const first = app.requestConfirmation({ action: 'LOCKDOWN' });
      const second = app.requestConfirmation({ action: 'ZEROIZE' });
      expect(await first).toBe(false);
      await app.handleConfirmLlmAction();
      expect(await second).toBe(true);
      expect(app._confirmationTimer).toBe(null);
    });
  });

  it('denies a confirmation that times out', async () => {
    await withDocument(async () => {
      const realSetTimeout = globalThis.setTimeout;
      let timeoutCallback = null;
      globalThis.setTimeout = (fn) => { timeoutCallback = fn; return 456; };
      try {
        const app = makeApp();
        const pending = app.requestConfirmation({ action: 'EMERGENCY_KILL' });
        expect(typeof timeoutCallback).toBe('function');
        timeoutCallback();
        expect(await pending).toBe(false);
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
    });
  });

  it('computes the trust badge from the contextual features', async () => {
    await withDocument(async (doc) => {
      const app = makeApp();
      app.publishTelemetry({ thermal: 20 }, {});
      expect(doc.getElementById('trust-score-badge').textContent).toBe('100');
      app.publishTelemetry({ thermal: 45 }, { critical_threshold_crossed: true });
      expect(doc.getElementById('trust-score-badge').textContent).toBe('70');
      app.publishTelemetry({ thermal: 45 }, { critical_threshold_crossed: true, novelty_detected: true });
      expect(doc.getElementById('trust-score-badge').textContent).toBe('50');
    });
  });
});
