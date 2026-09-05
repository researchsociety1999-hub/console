// Data Firewall: Input -> Trust -> Context -> Action
// Raw module samples enter here. Only a bounded AlertData object leaves.

const SEVERITY = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" });

function stageInput(rawSample) {
  if (!rawSample || typeof rawSample !== "object") return null;
  return {
    source: String(rawSample.source || "unknown").slice(0, 32),
    value: rawSample.value,
    timestamp: Date.now()
  };
}

function stageTrust(input) {
  if (!input) return null;
  const knownSources = ["thermal", "wifi", "ble", "nfc", "gpio", "watchdog"];
  const trusted = knownSources.includes(input.source);
  return { ...input, trusted };
}

function stageContext(trustedInput) {
  if (!trustedInput || !trustedInput.trusted) return null;
  let band = "normal";
  if (trustedInput.source === "thermal" && typeof trustedInput.value === "number") {
    band = trustedInput.value >= 38 ? "critical" : trustedInput.value >= 33 ? "elevated" : "normal";
  }
  return { ...trustedInput, band };
}

function stageAction(context) {
  if (!context) return null;
  let severity = SEVERITY.LOW;
  if (context.band === "elevated") severity = SEVERITY.MEDIUM;
  if (context.band === "critical") severity = SEVERITY.HIGH;

  return {
    type: `${context.source.toUpperCase()}_EVENT`,
    severity,
    source: context.source,
    ageSeconds: 0,
    createdAt: context.timestamp
  };
}

export function runDataFirewall(rawSample) {
  const input = stageInput(rawSample);
  const trusted = stageTrust(input);
  const context = stageContext(trusted);
  const alert = stageAction(context);
  return { input, trusted, context, alert };
}

export { SEVERITY };
