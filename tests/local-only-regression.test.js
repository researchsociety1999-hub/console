import { describe, expect, it } from "vitest";
import { JokerAdapter } from "../js/joker-adapter.js";
import { LocalModelRuntime } from "../js/local-model.js";
import { generateAlert } from "../js/data-firewall.js";

describe("local-only regression suite", () => {
  it("uses local inference output without any network fallback", async () => {
    const runtime = new LocalModelRuntime();
    runtime.loaded = true;
    runtime.wllama = { createCompletion: async () => "PREDICTED_STATE: WATCH | RECOMMENDATION: Monitor Trend" };
    const value = await runtime.runInference("Assess", { contextSummary: "temp=31" });
    expect(value).toContain("PREDICTED_STATE");
  });
  it("uses a caller-provided fallback only after local inference failure", async () => {
    const runtime = new LocalModelRuntime();
    runtime.loaded = true;
    runtime.wllama = { createCompletion: async () => { throw new Error("model unavailable"); } };
    const value = await runtime.runInference("Assess", { fallback: async () => "fallback result" });
    expect(value).toBe("fallback result");
  });
  it("creates a deterministic alert recommendation when no local model is available", async () => {
    const alert = await generateAlert({ type: "TEST", severity: "low", is_critical_leak: false }, { data_quality: "OK", value: { temperatureC: 20 } });
    expect(alert.recommendation).toBe("Monitor Trend");
    expect(alert.predicted_state).toBe("NOMINAL");
  });
  it("parses local AI predicted state and recommendation", async () => {
    const model = { runInference: async () => "PREDICTED_STATE: ELEVATED | RECOMMENDATION: Run cooling diagnostic" };
    const alert = await generateAlert({ type: "TEST", severity: "medium", is_critical_leak: false }, { data_quality: "OK", value: { temperatureC: 32 } }, model);
    expect(alert.predicted_state).toBe("ELEVATED");
    expect(alert.recommendation).toBe("Run cooling diagnostic");
    expect(alert.recommendationSource).toBe("ai");
  });
  it("forces top-priority critical leak for degraded hot sensor data", async () => {
    const alert = await generateAlert({ type: "TEST", severity: "low", is_critical_leak: false }, { data_quality: "DEGRADED", value: { temperatureC: 36 } });
    expect(alert.is_critical_leak).toBe(true);
    expect(alert.severity).toBe("critical");
    expect(alert.predicted_state).toBe("CRITICAL");
    expect(alert.sensorOverride).toBe(true);
  });
  it("exposes stealth state and returns a critical alert after confirmed kill", async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    expect(adapter.isStealthModeActive).toBe(false);
    await adapter.setStealthMode(true);
    expect(adapter.isStealthModeActive).toBe(true);
    const result = await adapter.killDevice({ confirmed: true });
    expect(result.success).toBe(true);
    expect(result.alert.severity).toBe("critical");
    expect(adapter.isDevicePoweredOff()).toBe(true);
  });
});
