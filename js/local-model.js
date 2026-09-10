import * as wllama from "https://cdn.jsdelivr.net/npm/@wllama/wllama@latest/dist/index.mjs";

// ============================================================================
// Model Catalog — centralized aliases so the UI only needs a friendly name
// ============================================================================
export const MODEL_CATALOG = {
  smolLM2: {
    repo: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF",
    file: "smollm2-360m-instruct-q4_k_m.gguf",
    label: "SmolLM2 360M (Q4_K_M)"
  },
  qwen05: {
    repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF",
    file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    label: "Qwen 2.5 0.5B (Q4_K_M)"
  },
  phi35: {
    repo: "microsoft/Phi-3.5-mini-instruct-GGUF",
    file: "phi-3.5-mini-instruct-q4_k_m.gguf",
    label: "Phi 3.5 Mini (Q4_K_M)"
  }
};

export class LocalModelRuntime {
  constructor() {
    this.wllama = null;
    this.model = null;
    this.loaded = false;
    this.loadingModelName = null;
  }

  /**
   * Load a model by alias ("smolLM2", "qwen05", "phi35") or explicit config.
   * Returns a promise that resolves when the model is ready for inference.
   */
  async loadModel(modelNameOrConfig = "smolLM2", onProgress) {
    const config =
      typeof modelNameOrConfig === "string"
        ? MODEL_CATALOG[modelNameOrConfig]
        : modelNameOrConfig;

    if (!config?.repo || !config?.file) {
      throw new Error(
        `Unknown model alias or invalid GGUF model configuration: ${JSON.stringify(modelNameOrConfig)}`
      );
    }

    this.loadingModelName = config.label;

    try {
      this.wllama = await wllama.create();
      this.model = await this.wllama.loadModel({
        repo: config.repo,
        file: config.file,
        onProgress: (progress) => {
          if (onProgress) onProgress(progress);
        }
      });
      this.loaded = true;
      return { success: true, model: config.label };
    } catch (error) {
      this.loaded = false;
      this.loadingModelName = null;
      throw error;
    }
  }

  /**
   * Run a single-turn completion with the loaded model.
   * Returns the generated text (string).
   */
  async runInference(prompt) {
    if (!this.loaded || !this.wllama || !this.model) {
      throw new Error("A local model must be loaded before inference.");
    }

    const result = await this.wllama.createCompletion(prompt, {
      nPredict: 256,
      sampling: {
        temp: 0.25,
        top_k: 40,
        top_p: 0.9
      }
    });

    return result.trim();
  }

  /**
   * Force an isolation-level inference: summarize telemetry and produce
   * a concise, safe operational recommendation.
   * This is the "Smart Summary" driver used by the Dashboard.
   */
  async forceIsolationRecommendation(telemetrySummary) {
    const prompt = [
      "<|system|>",
      "You are the Console local telemetry analyst.",
      "Use only the provided telemetry.",
      "Return a concise, safe operational recommendation.",
      "Do not claim to execute hardware actions.",
      "<|end|>",
      "<|user|>",
      `Summarize all current telemetry data and generate an actionable recommendation.
Telemetry: ${JSON.stringify(telemetrySummary)}`,
      "<|end|>",
      "<|assistant|>"
    ].join("\n");

    return this.runInference(prompt);
  }

  /**
   * Generic chat completion for the AI Assistant panel.
   */
  async chat(messages) {
    if (!this.loaded || !this.wllama || !this.model) {
      throw new Error("No local model loaded.");
    }

    const prompt = messages
      .map((m) => `${m.role === "system" ? "<|system|>" : m.role === "user" ? "<|user|>" : "<|assistant|>"}${m.content}<|end|>`)
      .join("\n") + "\n<|assistant|>";

    return this.runInference(prompt);
  }
}

// Singleton instance
export const localModel = new LocalModelRuntime();
export default localModel;