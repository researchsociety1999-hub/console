import jokerAdapter from "./joker-adapter.js";

const MODULE_SCHEMA = {
  wifi:    { accessPoints: "number", frameRate: "number" },
  ble:     { devices: "number", visibleIds: "array" },
  nfc:     { eventsLast5Min: "number" },
  gpio:    { pins: "array" },
  rgb:     { mode: "string", color: "string" },
  buzzer:  { freq: "number", duration: "number" },
  storage: { usedBytes: "number", freeBytes: "number" },
  badusb:  { status: "string" },
  thermal: { temperatureC: "number" }
};

function validateModulePacket(packet) {
  if (!packet || typeof packet !== "object") return false;
  if (!packet.source_module || !MODULE_SCHEMA[packet.source_module]) return false;
  if (typeof packet.ok !== "boolean") return false;
  if (packet.data_quality !== "OK" && packet.data_quality !== "DEGRADED") return false;
  if (!Number.isFinite(packet.timestamp) || packet.timestamp < 1e12 || packet.timestamp > Date.now() + 60000) return false;
  return true;
}

function sanitizeValue(moduleName, value) {
  const schema = MODULE_SCHEMA[moduleName];
  if (!schema || !value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, expectedType] of Object.entries(schema)) {
    if (key in value && typeof value[key] === expectedType) {
      clean[key] = value[key];
    }
  }
  return clean;
}

const SOURCE_REPUTATION = {
  wifi: 0.85, ble: 0.9, nfc: 0.95, gpio: 1.0, rgb: 1.0,
  buzzer: 1.0, storage: 0.9, badusb: 0.7, thermal: 0.95
};

function computeTrustScore(packet) {
  const base = SOURCE_REPUTATION[packet.source_module] ?? 0.5;
  const quality = packet.data_quality === "OK" ? 1.0 : 0.6;
  const freshness = Math.max(0, 1 - (Date.now() - packet.timestamp) / 30000);
  return Math.round(base * quality * freshness * 100) / 100;
}

export const CARD_STATE = {
  ONLINE: "ONLINE", DEGRADED: "DEGRADED", OFFLINE: "OFFLINE",
  GHOST: "GHOST", MANIFESTED: "MANIFESTED", LOST: "LOST"
};

function deriveCardState(validatedPackets) {
  if (validatedPackets.length === 0) return CARD_STATE.OFFLINE;
  const degradedCount = validatedPackets.filter(p => p.trust < 0.5).length;
  if (degradedCount / validatedPackets.length > 0.5) return CARD_STATE.DEGRADED;
  const hasCriticalThermal = validatedPackets.some(
    p => p.source_module === "thermal" && typeof p.value?.temperatureC === "number" && p.value.temperatureC > 85
  );
  if (hasCriticalThermal) return CARD_STATE.LOST;
  return CARD_STATE.ONLINE;
}

export const APPROVED_ACTIONS = [
  "RGB_MODE", "BUZZER_TONE", "GPIO_SET", "STEALTH_MODE", "MODULE_RESTART", "QUICK_HACK"
];

function isActionApproved(action) {
  return APPROVED_ACTIONS.includes(action);
}

const DETERMINISTIC_FALLBACK_RECOMMENDATION = "Monitor Trend";

/**
 * Main ingress pipeline for a single raw telemetry packet. Synchronous and
 * fast on purpose — this is the real-time validation hot path and must not
 * block on network/model calls. Optionally accepts deviceContext to gate
 * telemetry when the console isn't connected to a trusted device profile.
 *
 * HARD STOP: if the adapter reports the device is powered off/isolated,
 * no packet passes through — system is forced OFFLINE regardless of
 * whatever sensor readings might otherwise say.
 */
export function runDataFirewall(rawPacket, deviceContext = {}) {
  if (deviceContext && Object.prototype.hasOwnProperty.call(deviceContext, "connected") && !deviceContext.connected) {
    return {
      input: rawPacket,
      trusted: null,
      context: { state: CARD_STATE.OFFLINE, reason: "DEVICE_NOT_CONNECTED" },
      alert: {
        type: "DEVICE_NOT_CONNECTED",
        severity: "WARN",
        source: "firewall",
        predicted_state: "OFFLINE",
        recommendation: "CONNECT_DEVICE_PROFILE",
        is_critical_leak: false,
        createdAt: Date.now()
      }
    };
  }

  if (jokerAdapter.isDevicePoweredOff?.()) {
    return {
      input: null,
      trusted: null,
      context: { state: CARD_STATE.OFFLINE, reason: "DEVICE_POWERED_OFF" },
      alert: {
        type: "POWER_LOSS",
        severity: "critical",
        source: "adapter",
        predicted_state: "OFFLINE",
        recommendation: "RECONNECT_DEVICE_WHEN_READY",
        is_critical_leak: true,
        createdAt: Date.now()
      }
    };
  }

  if (!validateModulePacket(rawPacket)) {
    return {
      input: { ...rawPacket, _invalid: true },
      trusted: { score: 0, reason: "SCHEMA_VALIDATION_FAILED" },
      context: { state: CARD_STATE.OFFLINE, reason: "INVALID_PACKET" },
      alert: {
        type: "TELEMETRY_INVALID",
        severity: "WARN",
        source: "firewall",
        predicted_state: "OFFLINE",
        recommendation: "CHECK_FIRMWARE_SCHEMA",
        is_critical_leak: false,
        createdAt: Date.now()
      }
    };
  }

  const sanitized = { ...rawPacket, value: sanitizeValue(rawPacket.source_module, rawPacket.value) };
  const trust = computeTrustScore(sanitized);

  return {
    input: sanitized,
    trusted: { ...sanitized, trust },
    context: null,
    alert: trust < 0.3 ? {
      type: "TRUST_DEGRADED",
      severity: "WARN",
      source: "firewall",
      predicted_state: "DEGRADED",
      recommendation: "INSPECT_MODULE_HEALTH",
      is_critical_leak: false,
      createdAt: Date.now()
    } : null
  };
}

export function finalizeContext(validatedPackets) {
  const state = deriveCardState(validatedPackets);
  return { state, modules: validatedPackets.map(p => p.trusted), timestamp: Date.now() };
}

/**
 * AI-enriched alert generation. This is deliberately SEPARATE from
 * runDataFirewall()'s synchronous hot path — it's an async, best-effort
 * enrichment step that callers (Watchdog, app.js) can invoke when they
 * want an AI-generated recommendation and predicted_state attached to an
 * alert, without ever blocking real-time packet validation on an LLM call.
 *
 * Security gate: if the model returns an empty/unusable recommendation,
 * this falls back to a deterministic "Monitor Trend" recommendation so the
 * UI never receives an empty AlertData.recommendation field.
 *
 * @param {object} baseAlert - a deterministic alert object (from
 *   runDataFirewall's alert, or one synthesized by Watchdog) that already
 *   has at least { type, severity, is_critical_leak }.
 * @param {object} telemetrySnapshot - raw/trusted telemetry to ground the
 *   model's reasoning (kept small — pass a summary, not the full history).
 * @param {object} [localModel] - a LocalModelRuntime instance (or
 *   compatible object exposing runInference(prompt, {contextSummary})).
 *   If omitted or inference fails, the deterministic fallback is used.
 */
export async function generateAlert(baseAlert, telemetrySnapshot, localModel = null) {
  const alert = { ...baseAlert, createdAt: baseAlert.createdAt || Date.now() };

  if (!localModel || typeof localModel.runInference !== "function") {
    alert.recommendation = alert.recommendation || DETERMINISTIC_FALLBACK_RECOMMENDATION;
    alert.predicted_state = alert.predicted_state || "NOMINAL";
    return alert;
  }

  try {
    const contextSummary = typeof telemetrySnapshot === "string" ? telemetrySnapshot : JSON.stringify(telemetrySnapshot ?? {});
    const raw = await localModel.runInference(
      "Given this telemetry, respond with a single line: 'PREDICTED_STATE: <state> | RECOMMENDATION: <short action>'.",
      { contextSummary }
    );

    const predictedMatch = /PREDICTED_STATE:\s*([^|]+)/i.exec(raw || "");
    const recommendationMatch = /RECOMMENDATION:\s*(.+)$/i.exec(raw || "");

    const aiPredictedState = predictedMatch ? predictedMatch[1].trim() : "";
    const aiRecommendation = recommendationMatch ? recommendationMatch[1].trim() : (raw || "").trim();

    alert.predicted_state = aiPredictedState || alert.predicted_state || "NOMINAL";
    alert.recommendation = aiRecommendation || alert.recommendation || DETERMINISTIC_FALLBACK_RECOMMENDATION;
    alert.recommendationSource = "ai";
  } catch {
    alert.recommendation = alert.recommendation || DETERMINISTIC_FALLBACK_RECOMMENDATION;
    alert.predicted_state = alert.predicted_state || "NOMINAL";
    alert.recommendationSource = "deterministic_fallback";
  }

  if (!alert.recommendation || !alert.recommendation.trim()) {
    alert.recommendation = DETERMINISTIC_FALLBACK_RECOMMENDATION;
  }

  return alert;
}

export async function dispatchApprovedCommand(adapter, action, payload) {
  if (!isActionApproved(action)) {
    throw new Error(`Action ${action} is not in the approved command list`);
  }
  switch (action) {
    case "RGB_MODE": return adapter.setRgbMode(payload.mode);
    case "BUZZER_TONE": return adapter.sendBuzzerTone(payload.freq, payload.duration);
    case "GPIO_SET": return adapter.setGpioPin(payload.pin, payload.value);
    case "STEALTH_MODE": return adapter.setStealthMode(payload.enabled);
    case "MODULE_RESTART": return adapter.restartModule(payload.module);
    case "QUICK_HACK": return adapter.runQuickHack(payload.label);
    default: throw new Error(`Unhandled approved action: ${action}`);
  }
}

export { validateModulePacket, sanitizeValue, computeTrustScore, deriveCardState, isActionApproved };
