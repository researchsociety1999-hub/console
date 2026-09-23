const SENSITIVE_ACTIONS = new Set(['UNLOCK_VAULT_SESSION', 'ZEROIZE_ALL']);
const SUPPORTED_ACTIONS = new Set(['SET_GPIO_PIN', 'TOGGLE_MODULE', 'READ_THERMAL_SWEEP', 'UNLOCK_VAULT_SESSION', 'ZEROIZE_ALL']);

const SYSTEM_PROMPT = [
  'You are a local, on-device console administrator assistant running entirely in the browser.',
  'You may propose tool actions by emitting a single JSON object of the form {"action": "<ACTION_NAME>", "params": { ... }}.',
  'Supported actions: SET_GPIO_PIN, TOGGLE_MODULE, READ_THERMAL_SWEEP, UNLOCK_VAULT_SESSION, ZEROIZE_ALL.',
  'UNLOCK_VAULT_SESSION and ZEROIZE_ALL are destructive/sensitive and will only execute if the local user has explicitly confirmed them through the on-screen approval dialog; you cannot force their execution.',
  'Never fabricate hardware state. Never request or output credentials, PINs, passphrases, or card data.'
].join(' ');

export class LocalConsoleLLM {
  constructor({ appController = null, dataFirewall = null } = {}) {
    this.appController = appController;
    this.dataFirewall = dataFirewall;
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
    this.systemPrompt = SYSTEM_PROMPT;
  }

  async loadModelFromBlob(fileBlob, progressCallback) {
    if (!fileBlob) throw new Error('A local .gguf file is required.');
    const { Wllama } = await import('@wllama/wllama');
    this.wllama = new Wllama({});
    const modelUrl = URL.createObjectURL(fileBlob);
    try {
      await this.wllama.loadModel([modelUrl], {
        progressCallback: (progress) => { if (typeof progressCallback === 'function') progressCallback(progress); }
      });
    } finally {
      URL.revokeObjectURL(modelUrl);
    }
    this.loaded = true;
    this.loadingModelName = fileBlob.name || 'local-model.gguf';
    return { loaded: true, name: this.loadingModelName };
  }

  async executeUserCommand(userInput) {
    if (!this.loaded || !this.wllama) throw new Error('Load a local GGUF model before issuing commands.');
    const prompt = `${this.systemPrompt}\nUser: ${String(userInput || '').slice(0, 4000)}\nAssistant:`;
    const output = await this.wllama.createCompletion(prompt, { nPredict: 256 });
    return this.parseAndExecuteTools(output);
  }

  parseAndExecuteTools(modelOutput) {
    const text = String(modelOutput ?? '');
    const match = text.match(/\{[^{}]*"action"[^{}]*\}/);
    if (!match) return { response: text, executed: null };
    let command;
    try { command = JSON.parse(match[0]); } catch { return { response: text, executed: null, error: 'Malformed tool payload.' }; }
    return { response: text, executed: this.dispatchCommand(command) };
  }

  dispatchCommand(command) {
    const action = String(command?.action || '').toUpperCase();
    const params = command?.params && typeof command.params === 'object' ? command.params : {};
    if (!SUPPORTED_ACTIONS.has(action)) return { action, status: 'UNSUPPORTED', params };
    if (SENSITIVE_ACTIONS.has(action) && params.humanConfirmed !== true) {
      return { action, status: 'CONFIRMATION_REQUIRED', reason: 'This action requires explicit local user confirmation before execution.', params };
    }
    const handlers = {
      SET_GPIO_PIN: () => this.appController?.adapter?.setGpioPin?.(params.pin, params.value),
      TOGGLE_MODULE: () => this.appController?.adapter?.setModuleState?.(params.moduleId, params.state),
      READ_THERMAL_SWEEP: () => this.appController?.scanThermal?.(),
      UNLOCK_VAULT_SESSION: () => { this.appController?.handleVaultUnlock?.(params.passphrase); return { status: 'VAULT_UNLOCK_REQUESTED' }; },
      ZEROIZE_ALL: () => { this.appController?.clearAuditSession?.(); return { status: 'ZEROIZED' }; }
    };
    const result = handlers[action]?.();
    this.dataFirewall?.logEvent?.('LLM_TOOL_DISPATCH', { action, status: 'EXECUTED' })?.catch?.(() => {});
    return { action, status: 'EXECUTED', params, result };
  }

  unloadSession() {
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
  }
}
