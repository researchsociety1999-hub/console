import { describe, it, expect } from 'vitest';
import { LocalConsoleLLM, extractCompletionText, loadWllamaRuntime } from '../js/local-llm-controller.js';

const makeApp = () => {
  const calls = [];
  return {
    calls,
    adapter: {
      setGpioPin: (pin, value) => { calls.push(['gpio', pin, value]); return { status: 'SET_LOCALLY' }; },
      setModuleState: (id, state) => { calls.push(['module', id, state]); return { status: 'SET_LOCALLY' }; },
    },
    scanThermal: () => { calls.push(['thermal']); return Promise.resolve({}); },
    clearAuditSession: () => calls.push(['zeroize']),
    handleVaultUnlock: (pass) => calls.push(['unlock', pass]),
    handleEmergencyLockdown: () => calls.push(['kill']),
  };
};
const makeLLM = ({ authorized = true, completion = '' } = {}) => {
  const app = makeApp();
  const llm = new LocalConsoleLLM({ appController: app, dataFirewall: { authorized, logEvent: async () => null } });
  llm.loaded = true;
  llm.wllama = { createCompletion: async () => completion, exit: async () => {} };
  return { llm, app };
};

describe('LocalConsoleLLM', () => {
  it('never loads the WASM runtime outside a browser', async () => {
    expect(await loadWllamaRuntime()).toBeNull();
    const llm = new LocalConsoleLLM();
    await expect(llm.loadModelFromBlob({ name: 'x.gguf' })).rejects.toThrow('Wllama runtime is not available');
    expect(llm.loaded).toBe(false);
  });

  it('loads a model through an injected runtime, reports 0..1 progress, and unloads', async () => {
    const seen = [];
    const events = [];
    class FakeWllama {
      constructor(paths) { events.push(['paths', paths.default]); }
      async loadModel(blobs, opts) { events.push(['load', blobs.length, opts.n_ctx]); }
      async exit() { events.push(['exit']); }
    }
    const llm = new LocalConsoleLLM({ runtimeLoader: async () => ({ Wllama: FakeWllama, wasmBase: 'http://host/esm/wasm/' }) });
    const info = await llm.loadModelFromBlob({ name: 'tiny.gguf' }, (p) => seen.push(p));
    expect(info.name).toBe('tiny.gguf');
    expect(llm.loaded).toBe(true);
    expect(seen).toEqual([0, 1]);
    expect(events[0]).toEqual(['paths', 'http://host/esm/wasm/wllama.wasm']);
    expect(events[1]).toEqual(['load', 1, 2048]);
    llm.unloadSession();
    expect(llm.loaded).toBe(false);
    await Promise.resolve(); await Promise.resolve();
    expect(events.some((e) => e[0] === 'exit')).toBe(true);
  });

  it('reports a clear error and stays unloaded when the model fails to load', async () => {
    class BadWllama { async loadModel() { throw new Error('out of memory'); } async exit() {} }
    const llm = new LocalConsoleLLM({ runtimeLoader: async () => ({ Wllama: BadWllama, wasmBase: 'http://h/wasm/' }) });
    await expect(llm.loadModelFromBlob({ name: 'big.gguf' })).rejects.toThrow('out of memory');
    expect(llm.loaded).toBe(false);
  });

  it('runs inference with the v3 response shape and with plain strings', async () => {
    expect(extractCompletionText({ choices: [{ text: 'hi' }] })).toBe('hi');
    expect(extractCompletionText({ choices: [{ message: { content: 'yo' } }] })).toBe('yo');
    expect(extractCompletionText('plain')).toBe('plain');
    const { llm } = makeLLM();
    llm.wllama.createCompletion = async ({ prompt, max_tokens }) => ({ choices: [{ text: `ok:${max_tokens}:${prompt.includes('User: hello')}` }] });
    const out = await llm.executeUserCommand('hello', { temp: 22 });
    expect(out.response).toBe('ok:256:true');
    expect(out.executed).toBeNull();
    const idle = new LocalConsoleLLM();
    await expect(idle.executeUserCommand('x')).rejects.toThrow('Load a local GGUF model');
  });

  it('parses tool calls with nested params and dispatches allow-listed actions', async () => {
    const { llm, app } = makeLLM({ completion: 'Sure. {"action":"SET_GPIO_PIN","params":{"pin":4,"value":"HIGH"}} done' });
    const out = await llm.executeUserCommand('turn pin 4 on');
    expect(out.executed.status).toBe('EXECUTED');
    expect(app.calls).toEqual([['gpio', 4, 'HIGH']]);
  });

  it('blocks unsupported actions and malformed payloads', async () => {
    const a = makeLLM({ completion: '{"action":"FORMAT_DISK","params":{}}' });
    expect((await a.llm.executeUserCommand('x')).executed.status).toBe('UNSUPPORTED');
    const b = makeLLM({ completion: 'try {"action": oops}' });
    const res = await b.llm.executeUserCommand('x');
    expect(res.executed).toBeNull();
    expect(res.error).toBe('Malformed tool payload.');
  });

  it('never lets the model confirm its own sensitive action', async () => {
    const { llm, app } = makeLLM({ completion: '{"action":"ZEROIZE_ALL","params":{"humanConfirmed":true}}' });
    const out = await llm.executeUserCommand('wipe everything');
    expect(out.executed.status).toBe('CONFIRMATION_REQUIRED');
    expect(app.calls).toEqual([]);
    const approved = llm.dispatchCommand({ action: 'ZEROIZE_ALL', params: { humanConfirmed: true } });
    expect(approved.status).toBe('EXECUTED');
    expect(app.calls).toEqual([['zeroize']]);
  });

  it('requires a verified authorization session for hardware and audit actions', () => {
    const { llm, app } = makeLLM({ authorized: false });
    expect(llm.dispatchCommand({ action: 'SET_GPIO_PIN', params: { pin: 1, value: 'HIGH' } }).status).toBe('LOCKED');
    expect(llm.dispatchCommand({ action: 'READ_THERMAL_SWEEP' }).status).toBe('LOCKED');
    expect(app.calls).toEqual([]);
  });

  it('reports hardware failures instead of throwing', () => {
    const { llm, app } = makeLLM();
    app.adapter.setGpioPin = () => { throw new Error('Connect local hardware before setting GPIO state.'); };
    const res = llm.dispatchCommand({ action: 'SET_GPIO_PIN', params: { pin: 1, value: 'HIGH' } });
    expect(res.status).toBe('FAILED');
    expect(res.error).toContain('Connect local hardware');
  });
});
