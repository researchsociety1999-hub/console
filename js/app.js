import { ConsoleStateMachine, STATES } from "./state-machine.js";
import { JokerAdapter } from "./joker-adapter.js";
import { Watchdog } from "./watchdog.js";
import { Vault } from "./storage.js";
import { buildMinimalAgentContext, askAgent } from "./agent.js";
import { appendLog, escapeHtml, renderModuleGrid } from "./ui.js";
import { LocalModelRuntime, CURATED_MODELS } from "./local-model.js";
import { renderModuleDetailHtml } from "./module-detail.js";
import { HARDWARE_MODULES } from "./telemetry.js";

const root = document.getElementById("app");
const logEl = document.getElementById("log");

const SESSION_KEY = "console-session-v2";
const savedSession = safeParseJSON(sessionStorage.getItem(SESSION_KEY)) || {};
const history = Array.isArray(savedSession.history) ? savedSession.history : [];

function safeParseJSON(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

function persistSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      history: history.slice(0, 150),
      state: {
        thermal: state.thermal,
        aps: state.aps,
        ble: state.ble,
        nfcEvents: state.nfcEvents,
        recentAlerts: state.recentAlerts,
        cloudAgentEnabled: state.cloudAgentEnabled,
        preferLocal: state.preferLocal
      }
    }));
  } catch { /* storage may be unavailable in private mode */ }
}

const state = {
  mode: STATES.LOST,
  thermal: savedSession.state?.thermal ?? null,
  aps: savedSession.state?.aps ?? 0,
  ble: savedSession.state?.ble ?? 0,
  nfcEvents: savedSession.state?.nfcEvents ?? 0,
  recentAlerts: savedSession.state?.recentAlerts ?? [],
  cloudAgentEnabled: savedSession.state?.cloudAgentEnabled ?? false,
  preferLocal: savedSession.state?.preferLocal ?? true,
  lastModuleSamples: [],
  predictedState: "NOMINAL",
  thermalTrend: "stable"
};

const config = window.CONSOLE_CONFIG || {};
const adapter = new JokerAdapter();
const vault = new Vault();
const sm = new ConsoleStateMachine(render);
const localModel = new LocalModelRuntime();
let activeModule = null;
const actionQueue = [];

const MODULES = [
  { id: "nfc", name: "NFC / RFID", description: "PN532 \u00b7 13.56 MHz \u00b7 read/write" },
  { id: "wifi", name: "WiFi Lab", description: "Passive survey \u00b7 observe-only" },
  { id: "ble", name: "Bluetooth LE", description: "Scanner \u00b7 RSSI \u00b7 service hints" },
  { id: "badusb", name: "BadUSB (HID)", description: "Confirmation-gated payloads" },
  { id: "gpio", name: "GPIO Lab", description: "14-pin header \u00b7 HIGH/LOW" },
  { id: "rgb", name: "RGB Aura", description: "WS2812B effects & brightness" },
  { id: "buzzer", name: "Buzzer", description: "Tones \u00b7 melodies \u00b7 alerts" },
  { id: "storage", name: "Storage", description: "Vault \u00b7 dumps \u00b7 logs" },
  { id: "console", name: "Console", description: "Session terminal \u00b7 live log" },
  { id: "settings", name: "Settings", description: "AP config \u00b7 power \u00b7 system" }
];

const SEV_THEME = {
  low:      { color: "#3cf2ec", glow: "rgba(60,242,236,.28)" },
  medium:   { color: "#ffc857", glow: "rgba(255,200,87,.30)" },
  high:     { color: "#ff9a5a", glow: "rgba(255,154,90,.32)" },
  critical: { color: "#ff4f66", glow: "rgba(255,79,102,.38)" }
};

function log(msg, level = "INFO") {
  appendLog(logEl, history, msg, level);
  persistSession();
}

if (history.length) {
  logEl.innerHTML = history
    .slice(0, 150)
    .map((x) => `<div><time>${x.t}</time>[${x.level}] ${escapeHtml(x.msg)}</div>`)
    .join("");
}

function playBeep(freq = 880, durationMs = 160) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.type = "square";
    gain.gain.value = 0.05;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, durationMs);
  } catch { /* Web Audio unavailable */ }
}

// --- Severity theme: rewrites CSS variables consumed across every panel ---
function setSeverityTheme(severity) {
  const theme = SEV_THEME[severity] || SEV_THEME.low;
  document.documentElement.style.setProperty("--sev-color", theme.color);
  document.documentElement.style.setProperty("--sev-glow", theme.glow);
}

// --- Awareness Stack: visually pulses the 4 firewall stages on each tick ---
function pulsePipeline() {
  const stages = ["input", "trust", "context", "action"];
  stages.forEach((stageName, i) => {
    const el = document.querySelector(`.pipeline-stage[data-stage="${stageName}"]`);
    if (!el) return;
    setTimeout(() => {
      el.classList.add("active");
      setTimeout(() => el.classList.remove("active"), 700);
    }, i * 180);
  });
}

function render() {
  root.classList.remove("lost", "ghost", "manifested");
  root.classList.add(sm.state);

  document.getElementById("stateText").textContent =
    sm.state === STATES.LOST ? "LINK LOST" : sm.state === STATES.GHOST ? "GHOST / LOW POWER" : "MANIFESTED / TRUSTED";

  document.getElementById("ribbon").textContent =
    sm.state === STATES.LOST
      ? "STATUS RIBBON // WAITING FOR SECURE JOKER LINK"
      : sm.state === STATES.GHOST
      ? "GHOST PROTOCOL // ESSENTIAL SIGNALS ONLY"
      : "STATUS RIBBON // SENTINEL WATCHDOG ACTIVE";

  document.getElementById("temp").textContent = state.thermal ? `${state.thermal.toFixed(1)}\u00B0C` : "--";
  document.getElementById("devices").textContent = String(state.ble);
  document.getElementById("trust").textContent = sm.state === STATES.LOST ? "--" : "98%";
  document.getElementById("aps").textContent = String(state.aps);
  document.getElementById("ble").textContent = `${state.ble} devices`;
  document.getElementById("nfcEvents").textContent = String(state.nfcEvents);
  document.getElementById("predictedState").textContent = state.predictedState;
  document.getElementById("thermalTrend").textContent = state.thermalTrend;

  const vaultLine = document.getElementById("vault");
  if (vaultLine) vaultLine.textContent = vault.isUnlocked ? "UNLOCKED / ENCRYPTED (AES-256-GCM)" : "LOCKED / ENCRYPTED (AES-256-GCM)";
  const vaultDetail = document.getElementById("vaultDetailStatus");
  if (vaultDetail) vaultDetail.textContent = vault.isUnlocked ? "Unlocked" : "Locked";

  const intelEl = document.getElementById("intelSource");
  if (intelEl) {
    intelEl.textContent = localModel.loaded
      ? `LOCAL: ${localModel.loadingModelName}`
      : state.cloudAgentEnabled
      ? "CLOUD AGENT (OPENROUTER)"
      : "NO MODEL LOADED";
  }

  const blip = document.getElementById("blipPrimary");
  if (blip) {
    const activity = state.aps + state.ble + state.nfcEvents;
    blip.style.opacity = sm.state === STATES.LOST ? "0.15" : activity > 12 ? "1" : "0.6";
  }

  // --- Device Bridge (panel 06) ---
  document.getElementById("bridgeTransport").textContent = adapter.connected ? `Connected (${adapter.transport})` : "Disconnected";
  const okCount = state.lastModuleSamples.filter((s) => s.ok).length;
  document.getElementById("bridgeModuleCount").textContent = `${okCount} / ${HARDWARE_MODULES.length}`;

  if (activeModule) renderActiveModuleDetail();
  persistSession();
}

function renderActiveModuleDetail() {
  const title = document.getElementById("moduleDetailTitle");
  const body = document.getElementById("moduleDetailBody");
  const mod = MODULES.find((m) => m.id === activeModule);
  if (!mod || !body) return;
  title.textContent = `Module Detail \u00b7 ${mod.name}`;
  body.innerHTML = renderModuleDetailHtml(activeModule, state);
  wireModuleDetailActions(body);
}

function wireModuleDetailActions(container) {
  container.querySelectorAll("[data-action]").forEach((el) => {
    el.addEventListener("click", async () => {
      const action = el.dataset.action;
      if (action === "rescan") {
        const sample = adapter.sample();
        if (sample) {
          state.aps = sample.wifi.accessPoints;
          state.ble = sample.ble.devices;
          state.nfcEvents = sample.nfc.eventsLast5Min;
          log("Environment rescanned.", "INFO");
          render();
        } else {
          log("Cannot rescan: Joker not manifested.", "WARN");
        }
      } else if (action === "hack") {
        const label = el.dataset.label;
        if (!confirm(`Confirm action: ${label}?`)) return;
        await runHackPipeline(label);
      } else if (action === "gpio") {
        const pin = Number(el.dataset.pin);
        try {
          const target = document.getElementById(`gpioPin${pin}`);
          const next = target.textContent === "LOW" ? "HIGH" : "LOW";
          const result = await adapter.setGpioPin(pin, next);
          target.textContent = next;
          log(`GPIO pin ${pin} set to ${next} (${result.status})`, "ACTION");
        } catch (err) {
          log(String(err.message || err), "ERROR");
        }
      } else if (action === "rgb") {
        const effect = el.dataset.effect;
        try {
          const result = await adapter.setRgbMode(effect);
          log(`RGB Aura mode set to "${effect}" (${result.status})`, "ACTION");
        } catch (err) {
          log(String(err.message || err), "ERROR");
        }
      } else if (action === "buzzer-test") {
        playBeep(880, 180);
        try { await adapter.sendBuzzerTone(880, 180); } catch { /* adapter may be disconnected */ }
        log("Buzzer test tone played (Web Audio, no hardware required).", "ACTION");
      } else if (action === "scroll") {
        const target = document.getElementById(el.dataset.target);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
  });
}

// --- Hack Pipeline (panel 08): Select -> Path -> Execute -> Feedback ---
async function runHackPipeline(label) {
  const steps = ["select", "path", "execute", "feedback"];
  const stepper = document.getElementById("hackStepper");
  stepper.querySelectorAll(".step").forEach((s) => s.classList.remove("done"));

  for (let i = 0; i < steps.length - 1; i++) {
    stepper.querySelector(`[data-step="${steps[i]}"]`)?.classList.add("done");
    await new Promise((r) => setTimeout(r, 150));
  }

  try {
    const result = await adapter.runQuickHack(label);
    stepper.querySelector('[data-step="feedback"]')?.classList.add("done");
    log(`${label} \u2014 ${result.status}`, "ACTION");
    if (vault.isUnlocked) await vault.store({ type: "ACTION", label, at: result.executedAt });
    pushActionQueue(label, "feedback");
  } catch (err) {
    log(String(err.message || err), "ERROR");
    pushActionQueue(label, "failed");
  }
}

function pushActionQueue(label, status) {
  actionQueue.unshift({ label, status, at: new Date().toLocaleTimeString() });
  const el = document.getElementById("actionQueue");
  el.innerHTML = actionQueue.slice(0, 8)
    .map((a) => `<div class="qi"><b>${escapeHtml(a.label)}</b> \u2014 ${a.status} <span style="float:right;color:#587278;">${a.at}</span></div>`)
    .join("");
}

// --- Action Logic: routes AlertData.recommendation to a specific command ---
async function handleRecommendation(alert) {
  const rec = alert.recommendation || "MONITOR";

  if (rec.startsWith("RESTART_MODULE:")) {
    const moduleName = rec.split(":")[1];
    log(`Watchdog recommendation: restart module "${moduleName}".`, "WATCHDOG");
    try {
      const result = await adapter.restartModule(moduleName);
      log(`Module "${moduleName}" restart ${result.recovered ? "succeeded" : "did not resolve the fault"}.`, result.recovered ? "ACTION" : "WARN");
      pushActionQueue(`Restart ${moduleName}`, result.recovered ? "recovered" : "unresolved");
    } catch (err) {
      log(String(err.message || err), "ERROR");
    }
    return;
  }

  if (rec === "RUN_COOLING_DIAGNOSTIC") {
    log("Watchdog recommendation: run cooling diagnostic.", "WATCHDOG");
    document.getElementById("agent").textContent =
      "Predicted sustained high temperature. Cooling Diagnostic recommended \u2014 verify airflow and reduce nearby RF/compute load.";
    try {
      await adapter.setRgbMode("alert-sweep");
      await adapter.sendBuzzerTone(1200, 220);
    } catch { /* adapter may be disconnected */ }
    pushActionQueue("Cooling Diagnostic", "triggered");
    return;
  }

  if (rec === "LOG_AND_MONITOR") {
    log("Watchdog recommendation: log and monitor new BLE device.", "WATCHDOG");
    if (vault.isUnlocked) await vault.store(alert);
    pushActionQueue("Log new BLE device", "logged");
    return;
  }

  if (rec === "FLAG_FOR_REVIEW") {
    log("Watchdog recommendation: flag outlier reading for review.", "WATCHDOG");
    pushActionQueue("Flag outlier", "flagged");
    return;
  }

  // Default MONITOR path: no action beyond logging.
  pushActionQueue(alert.type, "monitored");
}

async function manifest() {
  await adapter.connect();
  sm.manifest();
  const sample = adapter.sample();
  if (sample) {
    state.thermal = sample.thermal;
    state.aps = sample.wifi.accessPoints;
    state.ble = sample.ble.devices;
    state.nfcEvents = sample.nfc.eventsLast5Min;
  }
  log("Trusted Joker session manifested. Data Firewall enabled.", "SECURE");
  document.getElementById("agent").textContent =
    "Live context established. Environmental telemetry is being interpreted through the trust and context stages.";
  render();
}

document.getElementById("connect").addEventListener("click", manifest);

document.getElementById("ghost").addEventListener("click", () => {
  if (sm.state === STATES.LOST) return manifest();
  sm.enterGhost();
  log(sm.state === STATES.GHOST ? "Ghost Protocol entered; nonessential UI suppressed." : "Ghost Protocol exited.");
});

document.getElementById("stateBtn").addEventListener("click", () => {
  sm.sever();
  adapter.disconnect();
  log("Secure link intentionally severed.", "WARN");
});

document.getElementById("diagnostic").addEventListener("click", async () => {
  log("Cooling diagnostic initiated (simulated command).", "ACTION");
  document.getElementById("agent").textContent =
    "Cooling Diagnostic queued. Verify physical thermal controls and power conditions are safe before executing hardware commands.";
  try { await adapter.setRgbMode("alert-sweep"); } catch { /* adapter may be disconnected */ }
});

document.querySelectorAll("[data-command]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const label = btn.dataset.command;
    if (!confirm(`Confirm action: ${label}?`)) return;
    await runHackPipeline(label);
  });
});

document.getElementById("exportIntel").addEventListener("click", async () => {
  if (!vault.isUnlocked) {
    log("Export failed: unlock the vault in Settings first.", "WARN");
    return;
  }
  try {
    const records = await vault.exportAll();
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `console-vault-export-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    log(`Exported ${records.length} decrypted vault record(s) to a local JSON download.`, "ACTION");
  } catch (err) {
    log(`Export failed: ${err.message || err}`, "ERROR");
  }
});

document.getElementById("clearVault").addEventListener("click", async () => {
  if (!confirm("Clear all encrypted vault history? This cannot be undone.")) return;
  await vault.clearAll();
  log("Vault history cleared.", "ACTION");
});

document.getElementById("unlockVault").addEventListener("click", async () => {
  const pass = document.getElementById("vaultPass").value;
  if (!pass) {
    log("Enter a passphrase to unlock the vault.", "WARN");
    return;
  }
  await vault.unlock(pass);
  log("Vault unlocked for this session.", "SECURE");
  render();
});

const moduleGrid = document.getElementById("moduleGrid");
function selectModule(id) {
  activeModule = id;
  renderModuleGrid(moduleGrid, MODULES, activeModule, selectModule);
  renderActiveModuleDetail();
  log(`Module selected: ${MODULES.find((m) => m.id === id).name}`);
}
renderModuleGrid(moduleGrid, MODULES, activeModule, selectModule);

const curatedGrid = document.getElementById("curatedModelGrid");
const modelStatusEl = document.getElementById("modelStatus");
const modelProgressEl = document.getElementById("modelProgress");

function setModelStatus(text, progress) {
  modelStatusEl.textContent = text;
  if (progress != null) modelProgressEl.textContent = `${progress}%`;
}

async function loadLocalModel(repo, file, label) {
  setModelStatus(`Downloading ${label}\u2026`, 0);
  log(`Local model download started: ${repo}/${file}`, "MODEL");
  try {
    await localModel.loadFromHF(repo, file, (pct) => {
      if (pct != null) setModelStatus(`Downloading ${label}\u2026`, pct);
    });
    setModelStatus(`Loaded: ${label} (running fully offline in this tab)`, 100);
    log(`Local model ready: ${label}. No API key or network calls required for inference.`, "MODEL");
    render();
  } catch (err) {
    setModelStatus(`Failed to load ${label}: ${err.message || err}`, null);
    log(`Local model load failed: ${err.message || err}`, "ERROR");
  }
}

renderModuleGrid(curatedGrid, CURATED_MODELS.map((m) => ({ id: m.id, name: m.name, description: `${m.size} \u00b7 ${m.note}` })), null, (id) => {
  const model = CURATED_MODELS.find((m) => m.id === id);
  if (model) loadLocalModel(model.repo, model.file, model.name);
});

document.getElementById("loadCustomModel").addEventListener("click", () => {
  const repo = document.getElementById("customRepo").value.trim();
  const file = document.getElementById("customFile").value.trim();
  if (!repo || !file) {
    setModelStatus("Enter both a Hugging Face repo and a GGUF filename.", null);
    return;
  }
  loadLocalModel(repo, file, `${repo}/${file}`);
});

document.getElementById("unloadModel").addEventListener("click", async () => {
  await localModel.unload();
  setModelStatus("No local model loaded", 0);
  log("Local model unloaded.", "MODEL");
  render();
});

document.getElementById("preferLocalToggle").addEventListener("change", (e) => {
  state.preferLocal = e.target.checked;
  persistSession();
});

document.getElementById("cloudAgentToggle").addEventListener("change", (e) => {
  state.cloudAgentEnabled = e.target.checked;
  log(`Cloud Agent ${state.cloudAgentEnabled ? "enabled" : "disabled"} by operator.`, "SETTINGS");
  render();
});

document.getElementById("buzzerToggle").addEventListener("change", (e) => {
  log(`Buzzer on alerts ${e.target.checked ? "enabled" : "disabled"}.`, "SETTINGS");
});

document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("question");
  const question = input.value.trim();
  if (!question) return;
  log(`USER: ${question}`, "QUERY");

  const contextSummary = buildMinimalAgentContext(state);

  if (state.preferLocal && localModel.loaded) {
    document.getElementById("agent").textContent = "Local model is thinking\u2026 (fully offline, no network call)";
    try {
      const answer = await localModel.ask(question, contextSummary);
      document.getElementById("agent").textContent = answer;
      log(`AGENT (local model): ${answer}`, "AGENT");
    } catch (err) {
      document.getElementById("agent").textContent = `Local model error: ${err.message || err}`;
      log(`Local model error: ${err.message || err}`, "ERROR");
    }
    input.value = "";
    return;
  }

  if (state.cloudAgentEnabled) {
    const result = await askAgent({
      message: question,
      context: contextSummary,
      accessToken: window.__consoleAccessToken || "",
      functionUrl: config.AGENT_FUNCTION_URL,
      includeAlerts: true
    });
    const answer = result.answer || `Cloud agent unavailable (${result.error || "not configured"}).`;
    document.getElementById("agent").textContent = answer;
    log(`AGENT (cloud): ${answer}`, "AGENT");
    input.value = "";
    return;
  }

  const local = sm.state === STATES.LOST
    ? "No trusted live link is available. Manifest the card first."
    : `Local read: ${state.thermal?.toFixed(1)}\u00B0C, ${state.aps} APs, ${state.ble} BLE devices. Load a Local Model (no API key) or enable Cloud Agent in Settings for narrative analysis.`;
  document.getElementById("agent").textContent = local;
  log(`AGENT (raw): ${local}`, "AGENT");
  input.value = "";
});

// --- Watchdog: 15s interval, per-module health + BLE novelty + thermal ---
const watchdog = new Watchdog({
  intervalMs: 15000,
  isActive: () => sm.state === STATES.MANIFESTED,
  getThermalSample: () => {
    const sample = adapter.sample();
    if (!sample) return null;
    state.thermal = sample.thermal;
    state.aps = sample.wifi.accessPoints;
    state.ble = sample.ble.devices;
    state.nfcEvents = sample.nfc.eventsLast5Min;
    return sample.thermal;
  },
  getModuleSamples: () => {
    const samples = adapter.sampleAllModules();
    state.lastModuleSamples = samples;
    return samples;
  },
  onAlert: async (alert) => {
    state.recentAlerts.unshift(alert);
    state.recentAlerts = state.recentAlerts.slice(0, 30);
    state.predictedState = alert.predictedState || state.predictedState;
    state.thermalTrend = alert.trend || state.thermalTrend;

    const alertEl = document.getElementById("alert");
    if (alertEl) alertEl.outerHTML = `<span class="severity ${alert.severity}" id="alert">${alert.type}</span>`;
    log(`Watchdog: ${alert.type} (${alert.severity}) \u2014 recommendation: ${alert.recommendation}`, "ALERT");

    setSeverityTheme(alert.severity);
    pulsePipeline();

    const buzzerOn = document.getElementById("buzzerToggle")?.checked;
    if (buzzerOn && (alert.severity === "medium" || alert.severity === "high" || alert.severity === "critical")) {
      playBeep(alert.severity === "critical" ? 1200 : alert.severity === "high" ? 1000 : 700, 220);
    }

    if (vault.isUnlocked) {
      try { await vault.store(alert); } catch { /* non-fatal */ }
    }

    await handleRecommendation(alert);
    render();
  }
});
watchdog.start();

log("Console initialized. Session cache restored. Watchdog running every 15s across all 8 hardware modules.");
render();
