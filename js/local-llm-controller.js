/**
 * LocalConsoleLLM - Local GGUF Model Orchestrator (Wllama, runs in the browser tab)
 *
 * - Node/Vitest environments never load the WASM runtime (loadWllamaRuntime() returns null).
 * - In a browser the runtime is imported from a local path (vendor/wllama first, then
 *   node_modules), so no CDN or bare-specifier resolution is needed.
 * - Model output is advisory: tool calls are parsed from text, checked against an allow-list,
 *   sensitive actions need an explicit on-screen confirmation, and hardware/audit actions
 *   need a verified authorization session.
 */

const ENGINE_ENTRYPOINTS = ['../vendor/wllama/esm/index.js', '../node_modules/@wllama/wllama/esm/index.js'];

const SENSITIVE_ACTIONS = new Set(['UNLOCK_VAULT_SESSION', 'ZEROIZE_ALL', 'EMERGENCY_KILL']);
const AUTH_REQUIRED_ACTIONS = new Set(['SET_GPIO_PIN', 'TOGGLE_MODULE', 'READ_THERMAL_SWEEP']);
const SUPPORTED_ACTIONS = new Set(['SET_GPIO_PIN', 'TOGGLE_MODULE', 'READ_THERMAL_SWEEP', 'UNLOCK_VAULT_SESSION', 'ZEROIZE_ALL', 'EMERGENCY_KILL']);

const SYSTEM_PROMPT = [
  'You are a local, on-device console administrator assistant running entirely in the browser.',
  'You may propose tool actions by emitting a single JSON object of the form {"action": "<ACTION_NAME>", "params": { ... }}.',
  'Supported actions: SET_GPIO_PIN, TOGGLE_MODULE, READ_THERMAL_SWEEP, UNLOCK_VAULT_SESSION, ZEROIZE_ALL, EMERGENCY_KILL.',
  'UNLOCK_VAULT_SESSION, ZEROIZE_ALL and EMERGENCY_KILL are sensitive and will only execute if the local user has explicitly confirmed them through the on-screen approval dialog; you cannot force their execution.',
  'Never fabricate hardware state. Never request or output credentials, PINs, passphrases, or card data.'
].join(' ');

export async function loadWllamaRuntime() {
  // Never load native WASM modules in Node/Vitest runs.
  if (typeof window === 'undefined' || globalThis.process?.versions?.node) {
    return null;
  }
  let lastError = null;
  for (const relative of ENGINE_ENTRYPOINTS) {
    const entry = new URL(relative, import.meta.url).href;
    try {
      const module = await import(/* @vite-ignore */ entry);
      const Wllama = module.Wllama ?? module.default ?? null;
      if (Wllama) return { Wllama, wasmBase: new URL('wasm/', entry).href };
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) console.warn('Wllama runtime unavailable, falling back to standby controller:', lastError);
  return null;
}

export async function loadWllamaEngine() {
  const runtime = await loadWllamaRuntime();
  return runtime ? runtime.Wllama : null;
}

export function extractCompletionText(result) {
  if (typeof result === 'string') return result;
  const choice = result?.choices?.[0];
  return choice?.text ?? choice?.message?.content ?? '';
}

function extractToolCall(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') {
        inString = true;
      } else if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1));
            if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') return { command: parsed };
          } catch { /* keep scanning */ }
          break;
        }
      }
    }
  }
  return null;
}

export class LocalConsoleLLM {
  constructor(config = {}) {
    this.modelPath = config.modelPath || null;
    this.ready = false;
    this.config = { ...config };
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
    this.appController = config.appController ?? null;
    this.dataFirewall = config.dataFirewall ?? null;
    this.runtimeLoader = config.runtimeLoader ?? loadWllamaRuntime;
    this.systemPrompt = SYSTEM_PROMPT;
  }

  async loadModelFromBlob(blob, onProgress) {
    if (!blob) throw new Error('A local .gguf file is required.');
    const report = (value) => {
      try { if (typeof onProgress === 'function') onProgress(value); } catch { /* UI callback must not break loading */ }
    };

    const runtime = await this.runtimeLoader();
    if (!runtime) {
      throw new Error('The Wllama runtime is not available here. Serve the app over http(s) with node_modules/@wllama/wllama (or vendor/wllama) present, in a browser with WebAssembly support.');
    }

    this.unloadSession();
    report(0);
    const wllama = new runtime.Wllama({ default: new URL('wllama.wasm', runtime.wasmBase).href });
    try {
      await wllama.loadModel([blob], { n_ctx: this.config.nCtx ?? 2048 });
    } catch (error) {
      try { await wllama.exit?.(); } catch { /* best-effort cleanup */ }
      throw new Error(`Model load failed: ${error?.message ?? error}`);
    }

    this.wllama = wllama;
    this.loaded = true;
    this.ready = true;
    this.loadingModelName = blob.name || 'local-model.gguf';
    report(1);
    return { loaded: true, name: this.loadingModelName };
  }

  async complete(prompt, { maxTokens = 256, temperature = 0.2 } = {}) {
    if (!this.loaded || !this.wllama) throw new Error('Load a local GGUF model before issuing commands.');
    const result = await this.wllama.createCompletion({ prompt, max_tokens: maxTokens, temperature });
    return extractCompletionText(result);
  }

  async executeUserCommand(userInput, context = {}) {
    if (!this.loaded || !this.wllama) throw new Error('Load a local GGUF model before issuing commands.');
    const snapshot = context && Object.keys(context).length ? JSON.stringify(context).slice(0, 2000) : '';
    const contextLine = snapshot ? `\nLive telemetry snapshot: ${snapshot}` : '';
    const prompt = `${this.systemPrompt}${contextLine}\nUser: ${String(userInput || '').slice(0, 4000)}\nAssistant:`;
    return this.parseAndExecuteTools(await this.complete(prompt));
  }

  parseAndExecuteTools(modelOutput) {
    const text = String(modelOutput ?? '');
    const found = extractToolCall(text);
    if (!found) {
      return { response: text, executed: null, ...(text.includes('"action"') ? { error: 'Malformed tool payload.' } : {}) };
    }
    // The model can never self-confirm: only the on-screen approval path may set humanConfirmed.
    const params = found.command.params && typeof found.command.params === 'object' ? { ...found.command.params } : {};
    delete params.humanConfirmed;
    return { response: text, executed: this.dispatchCommand({ action: found.command.action, params }) };
  }

  dispatchCommand(command) {
    const action = String(command?.action || '').toUpperCase();
    const params = command?.params && typeof command.params === 'object' ? command.params : {};
    if (!SUPPORTED_ACTIONS.has(action)) return { action, status: 'UNSUPPORTED', params };
    if (SENSITIVE_ACTIONS.has(action) && params.humanConfirmed !== true) {
      return { action, status: 'CONFIRMATION_REQUIRED', reason: 'This action requires explicit local user confirmation before execution.', params };
    }
    if (AUTH_REQUIRED_ACTIONS.has(action) && !this.dataFirewall?.authorized) {
      return { action, status: 'LOCKED', reason: 'Verify local authorization before running hardware or audit actions.', params };
    }

    const app = this.appController;
    const handlers = {
      SET_GPIO_PIN: () => app?.adapter?.setGpioPin?.(params.pin, params.value),
      TOGGLE_MODULE: () => app?.adapter?.setModuleState?.(params.moduleId, params.state),
      READ_THERMAL_SWEEP: () => app?.scanThermal?.(),
      UNLOCK_VAULT_SESSION: () => { app?.handleVaultUnlock?.(params.passphrase); return { status: 'VAULT_UNLOCK_REQUESTED' }; },
      ZEROIZE_ALL: () => { app?.clearAuditSession?.(); return { status: 'ZEROIZED' }; },
      EMERGENCY_KILL: () => { app?.handleEmergencyLockdown?.(); return { status: 'EMERGENCY_LOCKDOWN_REQUESTED' }; }
    };

    let result;
    try {
      result = handlers[action]();
    } catch (error) {
      return { action, status: 'FAILED', error: error?.message ?? String(error), params };
    }
    this.dataFirewall?.logEvent?.('LLM_TOOL_DISPATCH', { action, status: 'EXECUTED' })?.catch?.(() => {});
    return { action, status: 'EXECUTED', params, result };
  }

  async query(prompt) {
    if (!this.loaded || !this.wllama) {
      return { response: 'Local LLM initialized in mock/standby state.' };
    }
    return { response: await this.complete(String(prompt ?? '')) };
  }

  unloadSession() {
    const wllama = this.wllama;
    this.wllama = null;
    this.loaded = false;
    this.ready = false;
    this.loadingModelName = null;
    if (wllama && typeof wllama.exit === 'function') {
      Promise.resolve().then(() => wllama.exit()).catch(() => {});
    }
  }
}

export async function initializeLocalLLM(config = {}) {
  return new LocalConsoleLLM(config);
}
