// Local Model Runtime — on-device GGUF inference via wllama (WebAssembly).
// No API key, no server, no account. The GGUF file downloads once from
// Hugging Face and is cached by the browser; inference after that is fully
// offline. Public API matches what app.js calls:
//   new LocalModelRuntime()
//   .loaded / .loadingModelName
//   .loadFromHF(repo, file, onProgressPct)
//   .ask(question, contextSummary)
//   .unload()
// CURATED_MODELS is a small, safe default catalog for the launcher grid.

let wllamaModulePromise = null;
function loadWllamaModule() {
  if (!wllamaModulePromise) {
    wllamaModulePromise = import("https://cdn.jsdelivr.net/npm/@wllama/wllama@latest/dist/index.mjs");
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

  async loadFromHF(repo, file, onProgress) {
    if (!repo || !file) {
      throw new Error("A Hugging Face repo and GGUF filename are required.");
    }

    try {
      const wllamaMod = await loadWllamaModule();
      const WllamaCtor = wllamaMod.Wllama || wllamaMod.default;

      const modelUrl = `https://huggingface.co/${repo}/resolve/main/${file}`;

      this.wllama = new WllamaCtor({
        "single-thread/wllama.wasm": "https://cdn.jsdelivr.net/npm/@wllama/wllama@latest/dist/single-thread/wllama.wasm",
        "multi-thread/wllama.wasm": "https://cdn.jsdelivr.net/npm/@wllama/wllama@latest/dist/multi-thread/wllama.wasm"
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
      throw error;
    }
  }

  async ask(question, contextSummary) {
    if (!this.loaded || !this.wllama) {
      throw new Error("No local model loaded. Pick a model above first.");
    }

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

    const result = await this.wllama.createCompletion(prompt, {
      nPredict: 256,
      sampling: { temp: 0.3, top_k: 40, top_p: 0.9 }
    });

    return typeof result === "string" ? result.trim() : String(result).trim();
  }

  async forceIsolationRecommendation(telemetrySummary) {
    if (!this.loaded || !this.wllama) {
      throw new Error("No local model loaded.");
    }
    return this.ask(
      "Summarize all current telemetry data and generate an actionable recommendation.",
      typeof telemetrySummary === "string" ? telemetrySummary : JSON.stringify(telemetrySummary)
    );
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
