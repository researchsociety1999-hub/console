import { ConsoleStateMachine, STATES } from "./state-machine.js";
import { JokerAdapter } from "./joker-adapter.js";
import { Watchdog } from "./watchdog.js";
import { Vault } from "./storage.js";
import { buildMinimalAgentContext, askAgent } from "./agent.js";
import { appendLog, escapeHtml, renderModuleGrid } from "./ui.js";
import { summarizeEnvironment } from "./telemetry.js";

const root = document.getElementById("app");
const logEl = document.getElementById("log");
const history = [];

const state = {
  mode: STATES.LOST,
  thermal: null,
  aps: 0,
  ble: 0,
  nfcEvents: 0,
  recentAlerts: [],
  cloudAgentEnabled: false
};

const config = window.CONSOLE_CONFIG || {};
const adapter = new JokerAdapter();
const vault = new Vault();
const sm = new ConsoleStateMachine(render);

const MODULES = [
  { id: "nfc", name: "NFC / RFID", description: "PN532 · 13.56 MHz · read/write" },
  { id: "wifi", name: "WiFi Lab", description: "Passive survey · observe-only" },
  { id: "ble", name: "Bluetooth LE", description: "Scanner · RSSI · service hints" },
  { id: "badusb", name: "BadUSB (HID)", description: "Confirmation-gated payloads" },
  { id: "gpio", name: "GPIO Lab", description: "14-pin header · HIGH/LOW" },
  { id: "rgb", name: "RGB Aura", description: "WS2812B effects & brightness" },
  { id: "buzzer", name: "Buzzer", description: "Tones · melodies · alerts" },
  { id: "storage", name: "Storage", description: "Vault · dumps · logs" }
];

function log(msg, level = "INFO") {
  appendLog(logEl, history, msg, level);
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

  document.getElementById("temp").textContent = state.thermal ? `${state.thermal.toFixed(1)}°C` : "--";
  document.getElementById("devices").textContent = String(state.ble);
  document.getElementById("trust").textContent = sm.state === STATES.LOST ? "--" : "98%";
  document.getElementById("aps").textContent = String(state.aps);
  document.getElementById("ble").textContent = `${state.ble} devices`;
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

document.getElementById("diagnostic").addEventListener("click", () => {
  log("Cooling diagnostic initiated (simulated command).", "ACTION");
  document.getElementById("agent").textContent =
    "Cooling Diagnostic queued. Verify physical thermal controls and power conditions are safe before executing hardware commands.";
});

document.querySelectorAll("[data-command]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const label = btn.dataset.command;
    if (!confirm(`Confirm action: ${label}?`)) return;
    try {
      const result = await adapter.runQuickHack(label);
      log(`${label} — ${result.status}`, "ACTION");
    } catch (err) {
      log(String(err.message || err), "ERROR");
    }
  });
});

const moduleGrid = document.getElementById("moduleGrid");
let activeModule = null;
renderModuleGrid(moduleGrid, MODULES, activeModule, (id) => {
  activeModule = id;
  renderModuleGrid(moduleGrid, MODULES, activeModule, () => {});
  log(`Module selected: ${MODULES.find((m) => m.id === id).name}`);
});

document.getElementById("chat").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = document.getElementById("question");
  const question = input.value.trim();
  if (!question) return;
  log(`USER: ${question}`, "QUERY");

  if (!state.cloudAgentEnabled) {
    const local = sm.state === STATES.LOST
      ? "No trusted live link is available. Manifest the card first."
      : `Local read: ${state.thermal?.toFixed(1)}°C, ${state.aps} APs, ${state.ble} BLE devices. Enable Cloud Agent in Settings for model-based analysis.`;
    document.getElementById("agent").textContent = local;
    log(`AGENT (local): ${local}`, "AGENT");
    input.value = "";
    return;
  }

  const context = buildMinimalAgentContext(state);
  const result = await askAgent({
    message: question,
    context,
    accessToken: window.__consoleAccessToken || "",
    functionUrl: config.AGENT_FUNCTION_URL,
    includeAlerts: true
  });

  const answer = result.answer || `Cloud agent unavailable (${result.error || "not configured"}).`;
  document.getElementById("agent").textContent = answer;
  log(`AGENT: ${answer}`, "AGENT");
  input.value = "";
});

document.getElementById("cloudAgentToggle").addEventListener("change", (e) => {
  state.cloudAgentEnabled = e.target.checked;
  log(`Cloud Agent ${state.cloudAgentEnabled ? "enabled" : "disabled"} by operator.`, "SETTINGS");
});

const watchdog = new Watchdog({
  intervalMs: 10000,
  isActive: () => sm.state === STATES.MANIFESTED,
  getSample: () => adapter.sample(),
  onAlert: (alert) => {
    state.recentAlerts.unshift(alert);
    state.recentAlerts = state.recentAlerts.slice(0, 20);
    const alertEl = document.getElementById("alert");
    if (alertEl) alertEl.outerHTML = `<span class="severity ${alert.severity}" id="alert">${alert.type}</span>`;
    log(`Watchdog: ${alert.type} (${alert.severity})`, "ALERT");
    render();
  }
});
watchdog.start();

log("Console initialized. Local session cache restored.");
render();
