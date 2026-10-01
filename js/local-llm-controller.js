/**
 * LocalLLMController - Local GGUF Model Orchestrator
 */

export class LocalConsoleLLM {
  constructor(config = {}) {
    this.modelPath = config.modelPath || null;
    this.ready = false;
    this.config = { ...config };
  }

  async query(prompt) {
    if (!this.ready) {
      return {
        response: 'Local LLM initialized in mock/standby state.'
      };
    }

    return {
      response: `Processed: ${String(prompt ?? '')}`
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

  try {
    const { Wllama } = await import('@wllama/wllama');
    return new Wllama(config);
  } catch (error) {
    console.warn(
      'Wllama dynamic import bypassed or unavailable in current runtime:',
      error
    );

    return new LocalConsoleLLM(config);
  }
}
