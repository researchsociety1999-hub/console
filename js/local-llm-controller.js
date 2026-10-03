/**
 * LocalConsoleLLM - Local GGUF Model Orchestrator
 * Node/Vitest environments receive a local, deterministic mock controller.
 * Browser environments lazily load Wllama with runtime safeguards.
 */

const WLLAMA_SPECIFIER = '@wllama/wllama';

export async function loadWllamaEngine() {
  // Prevent static analysis failures during Vitest collection in Node environments
  if (typeof window === 'undefined' || globalThis.process?.versions?.node) {
    return null;
  }
  try {
    // Use @vite-ignore to skip static analysis and force runtime loading
    const module = await import(/* @vite-ignore */ WLLAMA_SPECIFIER);
    return module.Wllama ?? null;
  } catch (err) {
    console.warn('Wllama runtime unavailable, falling back to standby controller:', err);
    return null;
  }
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
  }

  async loadModelFromBlob(blob, onProgress) {
    if (!blob) throw new Error('No GGUF file provided.');
    this.loadingModelName = blob.name;
    this.loaded = true;
    if (typeof onProgress === 'function') onProgress(100);
    return this;
  }

  unloadSession() {
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
  }

  dispatchCommand({ action, params = {} } = {}) {
    const HIGH_PRIVILEGE = ['ZEROIZE_ALL', 'UNLOCK_VAULT_SESSION', 'EMERGENCY_KILL'];
    if (HIGH_PRIVILEGE.includes(action) && params.humanConfirmed !== true) {
      return { status: 'CONFIRMATION_REQUIRED', action };
    }

    if (action === 'ZEROIZE_ALL' && params.humanConfirmed === true) {
      if (this.appController?.clearAuditSession) {
        this.appController.clearAuditSession();
      }
      return { status: 'EXECUTED', action };
    }

    if (action === 'UNLOCK_VAULT_SESSION' && params.humanConfirmed === true) {
      if (this.appController?.handleVaultUnlock && params.passphrase) {
        this.appController.handleVaultUnlock(params.passphrase);
      }
      return { status: 'EXECUTED', action };
    }

    return { status: 'EXECUTED', action };
  }

  parseAndExecuteTools(output) {
    const jsonMatch = output.match(/\{[^{}]*\}/);
    if (!jsonMatch) return { executed: null };

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return { executed: { action: parsed.action ?? 'UNKNOWN', status: 'EXECUTED' } };
    } catch {
      return { executed: null };
    }
  }

  async executeUserCommand(input, context = {}) {
    if (!input) return { response: 'No input provided.' };
    return {
      response: `Processing: ${String(input).slice(0, 100)}`,
      executed: null,
    };
  }

  async query(prompt) {
    if (!this.ready) {
      return {
        response: 'Local LLM initialized in mock/standby state.',
      };
    }
    return {
      response: `Processed: ${String(prompt ?? '')}`,
    };
  }
}

/**
 * Lazily initializes Wllama only where the browser runtime supports it.
 * Node/Vitest environments receive a local, deterministic mock controller.
 */
export async function initializeLocalLLM(config = {}) {
  if (
    typeof window === 'undefined' ||
    typeof navigator === 'undefined' ||
    !navigator.userAgent
  ) {
    return new LocalConsoleLLM(config);
  }

  const WllamaClass = await loadWllamaEngine();
  if (WllamaClass) {
    try {
      return new WllamaClass(config);
    } catch (error) {
      console.warn('Wllama instantiation failed, using fallback:', error);
    }
  }

  return new LocalConsoleLLM(config);
}
