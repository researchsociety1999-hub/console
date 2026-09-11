// Local Model Runtime — on-device GGUF inference via wllama (WebAssembly).
// No API key, no server, no account required for the default path. The GGUF
// file downloads once from Hugging Face and is cached by the browser;
// inference after that is fully offline. Public API used by app.js:
//   new LocalModelRuntime()
//   .loaded / .loadingModelName
//   .loadFromHF(repo, file, onProgressPct)
//   .ask(question, contextSummary)
//   .runInference(prompt, { contextSummary, fallback })
//   .unload()
// CURATED_MODELS is a small, safe default catalog for the launcher grid.

export function formatWllamaLoadError(error) {
  const raw = error && (error.message || String(error));
  if (!raw) {
    return "The Local Model runtime could not initialize in this browser session. Try reloading the page or using the Cloud Agent fallback.";
  }

  if (/cdn\.jsdelivr|Failed to fetch dynamically imported module|blocked|network|fetch/i.test(raw)) {
    return "The Local Model runtime was blocked while loading the Wllama browser package. The app now uses the locally installed library instead; if this still fails, the browser is preventing local module imports or the model download is unavailable.";
  }

  return raw;
}

let wllamaModulePromise = null;
function loadWllamaModule() {
  if (!wllamaModulePromise) {
    const localEntry = new URL("../node_modules/@wllama/wllama/esm/index.js", import.meta.url).href;
    wllamaModulePromise = import(localEntry).catch((error) => {
      throw new Error(formatWllamaLoadError(error));
    });
  }
  return wllamaModulePromise;
}

export const CURATED_MODELS = [
  {
    id: "smollm2-360m",
    name: "SmolLM2 360M Instruct",
    repo: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF",
    file: "smollm2-360m-instruct-q4_k_m.gguf",
    size: "~250MB",
    note: "Fastest, lowest memory"
  },
  {
    id: "qwen25-05b",
    name: "Qwen 2.5 0.5B Instruct",
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    size: "~400MB",
    note: "Balanced quality/speed"
  },
  {
    id: "phi35-mini",
    name: "Phi 3.5 Mini Instruct",
    repo: "microsoft/Phi-3.5-mini-instruct-GGUF",
    file: "phi-3.5-mini-instruct-q4_k_m.gguf",
    size: "~2.2GB",
    note: "Highest quality, slower load"
  }
];

export class LocalModelRuntime {
  constructor() {
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
  }

  /**
   * Download (once, cached by the browser) and load a GGUF model by
   * Hugging Face repo + filename. onProgress receives an integer 0-100
   * or null when progress is indeterminate.
   */
  async loadFromHF(repo, file, onProgress) {
    if (!repo || !file) {
      throw new Error("A Hugging Face repo and GGUF filename are required.");
    }

    try {
      const wllamaMod = await loadWllamaModule();
      const WllamaCtor = wllamaMod.Wllama || wllamaMod.default;

      const modelUrl = `https://huggingface.co/${repo}/resolve/main/${file}`;
      const wasmBase = new URL("../node_modules/@wllama/wllama/esm/wasm/", import.meta.url).href;

      this.wllama = new WllamaCtor({
        default: new URL("wllama.wasm", wasmBase).href
      });

      await this.wllama.loadModelFromUrl(modelUrl, {
        progressCallback: ({ loaded, total }) => {
          if (onProgress) {
            const pct = total ? Math.round((loaded / total) * 100) : null;
            onProgress(pct);
          }
        }
      });

      this.loaded = true;
      this.loadingModelName = `${repo}/${file}`;
      return { success: true, model: this.loadingModelName };
    } catch (error) {
      this.loaded = false;
      this.loadingModelName = null;
      this.wllama = null;
      throw new Error(formatWllamaLoadError(error));
    }
  }

  /**
   * Low-level completion against the loaded model only. Throws if no
   * model is loaded — callers that want automatic fallback should use
   * runInference() instead.
   */
  async _completeLocal(prompt) {
    if (!this.loaded || !this.wllama) {
      throw new Error("No local model loaded.");
    }

    const result = await this.wllama.createCompletion(prompt, {
      nPredict: 256,
      sampling: { temp: 0.3, top_k: 40, top_p: 0.9 }
    });

    return typeof result === "string" ? result.trim() : String(result).trim();
  }

  /**
   * Ask the loaded model a question, given a short plain-text context
   * summary built by the caller (e.g. buildMinimalAgentContext(state)).
   * Returns the generated answer string. Throws if no model is loaded.
   */
  async ask(question, contextSummary) {
    const prompt = [
      "<|system|>",
      "You are Console's on-device assistant. Answer using only the live telemetry context provided.",
      "Keep answers concise and factual. Do not claim to execute hardware actions yourself.",
      "<|end|>",
      "<|user|>",
      `Context: ${contextSummary || "No live context available."}`,
      `Question: ${question}`,
      "<|end|>",
      "<|assistant|>"
    ].join("\n");

    return this._completeLocal(prompt);
  }

  /**
   * Force an isolation-style inference: summarize telemetry into an
   * actionable recommendation string. Used by dashboard Smart Summary.
   * Falls through runInference() so it inherits the same fallback path.
   */
  async forceIsolationRecommendation(telemetrySummary, options = {}) {
    const contextSummary = typeof telemetrySummary === "string" ? telemetrySummary : JSON.stringify(telemetrySummary);
    return this.runInference(
      "Summarize all current telemetry data and generate an actionable recommendation.",
      { contextSummary, ...options }
    );
  }

  /**
   * The default inference entry point for the whole app. Prefers the
   * local model; if it is not loaded or the completion throws, it calls
   * an optional caller-supplied fallback function instead of ever
   * importing a cloud/Supabase client directly from this module. If no
   * fallback is supplied and the local model is unavailable, it rejects
   * with a clear, actionable error rather than failing silently.
   *
   * @param {string} prompt - the user's question or task.
   * @param {object} [options]
   * @param {string} [options.contextSummary] - grounding context text.
   * @param {(prompt: string, contextSummary: string) => Promise<string>} [options.fallback]
   *        Optional async function the caller wires to its own external
   *        agent (Cloud Agent, another API, etc). Only invoked if local
   *        inference fails or no model is loaded.
   */
  async runInference(prompt, options = {}) {
    const { contextSummary = "", fallback = null } = options;

    const fullPrompt = [
      "<|system|>",
      "You are Console's on-device assistant. Answer using only the live telemetry context provided.",
      "Keep answers concise and factual. Do not claim to execute hardware actions yourself.",
      "<|end|>",
      "<|user|>",
      `Context: ${contextSummary || "No live context available."}`,
      `Task: ${prompt}`,
      "<|end|>",
      "<|assistant|>"
    ].join("\n");

    if (this.loaded && this.wllama) {
      try {
        return await this._completeLocal(fullPrompt);
      } catch (localError) {
        if (typeof fallback === "function") {
          try {
            return await fallback(prompt, contextSummary);
          } catch (fallbackError) {
            throw new Error(
              `Local inference failed (${localError.message || localError}); fallback also failed (${fallbackError.message || fallbackError}).`
            );
          }
        }
        throw new Error(`Local inference failed and no fallback was configured: ${localError.message || localError}`);
      }
    }

    if (typeof fallback === "function") {
      return fallback(prompt, contextSummary);
    }

    throw new Error("No local model is loaded and no fallback was configured.");
  }

  async unload() {
    if (this.wllama) {
      try {
        if (typeof this.wllama.exit === "function") await this.wllama.exit();
      } catch { /* best-effort cleanup */ }
    }
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
  }
}
