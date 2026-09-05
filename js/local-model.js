// Local Model runtime: runs a GGUF LLM entirely inside the browser via
// WebAssembly (wllama, a binding for llama.cpp). No API key, no backend,
// and no data leaves the device. Models are downloaded from Hugging Face
// on first use and cached by the browser's Cache API for instant reloads.
//
// This is the "dedicated tab" intelligence layer: once a model is loaded
// here, it can answer questions about the live Console telemetry without
// any network call beyond the one-time model download.

const WLLAMA_MODULE_URL = "https://esm.sh/@wllama/wllama@2.3.4/esm/index.js";
const WLLAMA_WASM_CDN_URL = "https://esm.sh/@wllama/wllama@2.3.4/esm/wasm-from-cdn.js";

export const CURATED_MODELS = [
  { id: "smol135", name: "SmolLM2 135M", repo: "HuggingFaceTB/SmolLM2-135M-Instruct-GGUF", file: "smollm2-135m-instruct-q4_k_m.gguf", size: "~90 MB", note: "Instant load, good for testing" },
  { id: "smol360", name: "SmolLM2 360M", repo: "HuggingFaceTB/SmolLM2-360M-Instruct-GGUF", file: "smollm2-360m-instruct-q4_k_m.gguf", size: "~240 MB", note: "Fast, small footprint" },
  { id: "qwen05", name: "Qwen2.5 0.5B Instruct", repo: "Qwen/Qwen2.5-0.5B-Instruct-GGUF", file: "qwen2.5-0.5b-instruct-q4_k_m.gguf", size: "~390 MB", note: "Strong quality for its size" },
  { id: "llama1b", name: "Llama 3.2 1B Instruct", repo: "bartowski/Llama-3.2-1B-Instruct-GGUF", file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", size: "~760 MB", note: "General purpose, large context" }
];

export class LocalModelRuntime {
  constructor() {
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
  }

  async _ensureWllama() {
    if (this.wllama) return this.wllama;
    const [{ Wllama }, wasmModule] = await Promise.all([
      import(WLLAMA_MODULE_URL),
      import(WLLAMA_WASM_CDN_URL)
    ]);
    this.wllama = new Wllama(wasmModule.default);
    return this.wllama;
  }

  async loadFromHF(repo, file, onProgress) {
    const wllama = await this._ensureWllama();
    this.loaded = false;
    this.loadingModelName = `${repo}/${file}`;
    await wllama.loadModelFromHF(repo, file, {
      progressCallback: ({ loaded, total }) => {
        if (onProgress) onProgress(total ? Math.round((loaded / total) * 100) : null);
      }
    });
    this.loaded = true;
    return true;
  }

  async unload() {
    if (this.wllama) {
      try { await this.wllama.exit(); } catch { /* ignore */ }
    }
    this.wllama = null;
    this.loaded = false;
    this.loadingModelName = null;
  }

  async ask(question, contextSummary) {
    if (!this.loaded || !this.wllama) {
      throw new Error("Local model is not loaded");
    }

    const systemPrompt =
      "You are Console's local, fully offline assistant running entirely in the user's browser. " +
      "Use only the supplied trusted telemetry summary. Never claim access to data outside it. " +
      "Do not give instructions for unauthorized access, disruption, or physical harm. " +
      "Be concise and cite specific numbers from the summary when relevant.";

    const prompt =
      `<|system|>\n${systemPrompt}\n<|end|>\n` +
      `<|user|>\nTelemetry summary: ${JSON.stringify(contextSummary)}\n\nQuestion: ${question}\n<|end|>\n` +
      `<|assistant|>\n`;

    const output = await this.wllama.createCompletion(prompt, {
      nPredict: 220,
      sampling: { temp: 0.4, top_k: 40, top_p: 0.9 }
    });

    return output.trim();
  }
}
