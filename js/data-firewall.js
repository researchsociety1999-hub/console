// Data Firewall: Input -> Trust -> Context -> Action
// Raw module samples enter here. A bounded AlertData object is generated
// and returned BEFORE any UI update happens (callers pass the returned
// alert into updateUI()/onAlert(), never the other way around).

const SEVERITY = Object.freeze({ LOW: "low", MEDIUM: "medium", HIGH: "high", CRITICAL: "critical" });

/**
 * ContextEngine: lightweight trend/outlier/novelty analysis used by the
 * Context stage. Kept intentionally simple (rolling buffer, mean/stddev)
 * so it runs synchronously on every firewall pass with no dependencies.
 */
const ContextEngine = {
  _thermalBuffer: [],
  _maxBuffer: 8,

  analyzeTrend(value) {
    if (typeof value !== "number" || Number.isNaN(value)) return "stable";
    this._thermalBuffer.push(value);
    if (this._thermalBuffer.length > this._maxBuffer) this._thermalBuffer.shift();
    if (this._thermalBuffer.length < 4) return "stable";

    const mid = Math.floor(this._thermalBuffer.length / 2);
    const firstHalfAvg = avg(this._thermalBuffer.slice(0, mid));
    const secondHalfAvg = avg(this._thermalBuffer.slice(mid));
    const delta = secondHalfAvg - firstHalfAvg;

    if (delta > 0.6) return "rising";
    if (delta < -0.6) return "falling";
    return "stable";
  },

  isOutlier(value) {
    if (typeof value !== "number" || Number.isNaN(value) || this._thermalBuffer.length < 4) return false;
    const mean = avg(this._thermalBuffer);
    const sd = stddev(this._thermalBuffer, mean);
    if (sd === 0) return false;
    return Math.abs(value - mean) > 2 * sd;
  },

  reset() {
    this._thermalBuffer = [];
  }
};

function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stddev(arr, mean) {
  const variance = arr.reduce((sum, v) => sum + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * ActionSynthesizer: picks the single best recommendation from the
 * combination of Severity + PredictedState (+ alert type for module/BLE
 * special cases). Centralizing this keeps stageAction() declarative.
 */
function synthesizeAction(severity, predictedState, type, isOutlier) {
  if (type && type.endsWith("_MODULE_FAILURE")) {
    return `RESTART_MODULE:${type.replace("_MODULE_FAILURE", "").toLowerCase()}`;
  }
  if (type === "BLE_NEW_DEVICE") return "LOG_AND_MONITOR";
  if (predictedState === "HIGH_TEMP_STABLE" && severity === SEVERITY.CRITICAL) return "RUN_COOLING_DIAGNOSTIC_IMMEDIATE";
  if (severity === SEVERITY.HIGH) return "RUN_COOLING_DIAGNOSTIC";
  if (isOutlier) return "FLAG_FOR_REVIEW";
  return "MONITOR";
}

// ---- Stage 1: Input ----
function stageInput(rawSample) {
  if (!rawSample || typeof rawSample !== "object") return null;
  return {
    source: String(rawSample.source || "unknown").slice(0, 32),
    value: rawSample.value,
    dataQuality: rawSample.dataQuality || (rawSample.moduleOk === false ? "DEGRADED" : "OK"),
    isNew: !!rawSample.isNew,
    timestamp: Date.now()
  };
}

// ---- Stage 2: Trust ----
function stageTrust(input) {
  if (!input) return null;
  const knownSources = ["thermal", "wifi", "ble", "nfc", "gpio", "rgb", "buzzer", "storage", "badusb", "watchdog"];
  const trusted = knownSources.includes(input.source);
  return { ...input, trusted };
}

// ---- Stage 3: Context (ContextEngine-enriched) ----
function stageContext(trustedInput) {
  if (!trustedInput || !trustedInput.trusted) return null;

  let band = "normal";
  let trend = "stable";
  let predictedState = "NOMINAL";
  let isOutlier = false;

  if (trustedInput.source === "thermal" && typeof trustedInput.value === "number") {
    trend = ContextEngine.analyzeTrend(trustedInput.value);
    isOutlier = ContextEngine.isOutlier(trustedInput.value);
    band = trustedInput.value >= 38 ? "critical" : trustedInput.value >= 33 ? "elevated" : "normal";

    // --- PREDICTIVE LOGIC ---
    if (trend === "rising" && band !== "normal") {
      predictedState = "HIGH_TEMP_STABLE"; // rising AND already elevated/critical -> predicted sustained high temp
    } else if (trend === "rising") {
      predictedState = "TEMP_RISING";
    } else if (trend === "falling" && band !== "normal") {
      predictedState = "RECOVERING";
    }
  }

  return {
    ...trustedInput,
    band,
    trend,
    predictedState,
    is_outlier: isOutlier,
    is_new: !!trustedInput.isNew,
    data_quality: trustedInput.dataQuality
  };
}

// ---- Stage 4: Action (AlertData generation via ActionSynthesizer) ----
function stageAction(context) {
  if (!context) return null;
  const now = context.timestamp;

  // Module-level hardware failure takes priority over everything else.
  if (context.data_quality === "DEGRADED" && context.source !== "thermal") {
    const type = `${context.source.toUpperCase()}_MODULE_FAILURE`;
    return {
      type,
      severity: SEVERITY.HIGH,
      source: context.source,
      predicted_state: context.predictedState,
      band: context.band,
      recommendation: synthesizeAction(SEVERITY.HIGH, context.predictedState, type, false),
      is_critical_leak: false,
      ageSeconds: 0,
      createdAt: now
    };
  }

  // BLE / entity novelty -- fires at HIGH, proactively, independent of thermal state.
  if (context.is_new) {
    return {
      type: "BLE_NEW_DEVICE",
      severity: SEVERITY.HIGH,
      source: context.source,
      predicted_state: context.predictedState,
      band: context.band,
      recommendation: synthesizeAction(SEVERITY.HIGH, context.predictedState, "BLE_NEW_DEVICE", false),
      is_critical_leak: false,
      ageSeconds: 0,
      createdAt: now
    };
  }

  let severity = SEVERITY.LOW;
  if (context.band === "elevated") severity = SEVERITY.MEDIUM;
  if (context.band === "critical") severity = SEVERITY.HIGH;

  // --- PREDICTIVE ESCALATION: rising trend forces HIGH -> CRITICAL, even if
  //     the raw reading alone would only register as HIGH. ---
  if (context.trend === "rising" && severity === SEVERITY.HIGH) {
    severity = SEVERITY.CRITICAL;
  }

  if (severity === SEVERITY.LOW && !context.is_outlier) {
    return null; // nothing alert-worthy this cycle
  }

  const type = context.predictedState === "HIGH_TEMP_STABLE"
    ? "TEMP_PREDICTED_CRITICAL"
    : context.is_outlier
    ? `${context.source.toUpperCase()}_OUTLIER`
    : `${context.source.toUpperCase()}_EVENT`;

  const isCriticalLeak = severity === SEVERITY.CRITICAL && context.predictedState === "HIGH_TEMP_STABLE";

  return {
    type,
    severity: context.is_outlier && severity === SEVERITY.LOW ? SEVERITY.MEDIUM : severity,
    source: context.source,
    predicted_state: context.predictedState,
    band: context.band,
    trend: context.trend,
    is_outlier: context.is_outlier,
    recommendation: synthesizeAction(severity, context.predictedState, type, context.is_outlier),
    is_critical_leak: isCriticalLeak,
    ageSeconds: 0,
    createdAt: now
  };
}

/**
 * Runs the full 4-stage pipeline on a raw sample and returns the
 * intermediate results plus the final AlertData (or null). The caller is
 * responsible for forwarding `alert` to updateUI() -- the firewall itself
 * never touches the DOM.
 *
 * @param {{source:string, value:any, moduleOk?:boolean, dataQuality?:string, isNew?:boolean}} rawSample
 */
export function runDataFirewall(rawSample) {
  const input = stageInput(rawSample);
  const trusted = stageTrust(input);
  const context = stageContext(trusted);
  const alert = stageAction(context);
  return { input, trusted, context, alert };
}

export { SEVERITY, ContextEngine, synthesizeAction };
