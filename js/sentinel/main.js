import { CARD_PROTOCOL } from '../transports/card-protocol.js';
import { CARD_MAPPING } from '../transports/card-mapping.js';
import { createTransportFromDescriptor } from '../transports/index.js';
import { CardTelemetrySource } from './CardTelemetrySource.js';
import { SentinelConsole } from './SentinelConsole.js';
import { UIRenderer } from './UIRenderer.js';

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const element = $(id); if (element) element.textContent = text; };

const REASONS = {
  NO_CARD_COMMAND_CAPABILITY: 'This action needs a card command that is not configured, so nothing was sent.',
  CARD_DID_NOT_ACKNOWLEDGE: 'The card did not acknowledge the command.',
  DENIED_BY_HUMAN: 'You declined the action.',
  DEVICE_NOT_DETECTED: 'There is no fresh data from the card.',
  ACTION_NOT_ALLOWED: 'That action is not allowed.',
  KILL_SWITCH_ENGAGED: 'The kill switch is engaged.',
  INVALID_DATA: 'There is no valid reading yet.'
};

let transport = null;
let app = null;
let renderer = null;

const isConfigured = () => Boolean(CARD_PROTOCOL && CARD_MAPPING && typeof CARD_MAPPING.mapPacket === 'function');

function setConnection(label, detail = '') {
  setText('connectionState', label);
  setText('connectionDetail', detail);
}

function setButtons(connected) {
  $('connectButton').disabled = connected || !isConfigured();
  $('disconnectButton').disabled = !connected;
}

async function connect() {
  app?.stopMonitoringLoop();
  setConnection('CONNECTING', 'Opening the connection to the card...');
  setButtons(true);
  try {
    transport = createTransportFromDescriptor(CARD_PROTOCOL);
    transport.onDisconnect(() => {
      app?.stopMonitoringLoop();
      app?.store.patch({ cardState: 'lost' });
      setConnection('DISCONNECTED', 'The link to the card was lost. Readings were cleared.');
      setButtons(false);
    });
    const identity = await transport.connect();

    const source = new CardTelemetrySource({
      transport,
      mapPacket: CARD_MAPPING.mapPacket,
      requiredFields: CARD_MAPPING.requiredFields ?? []
    });
    app = new SentinelConsole({
      telemetry: source,
      metrics: CARD_MAPPING.metrics ?? [],
      resolveAfterCycles: CARD_MAPPING.resolveAfterCycles ?? null,
      commandBridge: CARD_MAPPING.createCommandBridge?.(transport) ?? null,
      autoAct: false, // actions run only when the operator clicks
      confirm: async (alert) => window.confirm(`Confirm "${alert.action}"?\n${alert.recommendation ?? ''}`)
    });
    renderer = new UIRenderer({ bus: app.bus, primaryMetric: CARD_MAPPING.primaryMetric ?? null });
    renderer.soundEnabled = $('soundToggle')?.checked === true;

    app.bus.on('telemetry:sample', () => setConnection('STREAMING', `Receiving data from ${identity.deviceName}.`));
    app.bus.on('firewall:rejected', ({ reason }) => {
      if (reason === 'DEVICE_NOT_DETECTED') setConnection('CONNECTED, NO FRESH DATA', `Connected to ${identity.deviceName}, but no fresh readings are arriving.`);
    });

    setConnection('CONNECTED, WAITING FOR DATA', `Connected to ${identity.deviceName}. No readings yet.`);
    app.store.patch({ cardState: 'ghost' });
    app.startMonitoringLoop();
  } catch (error) {
    setConnection('ERROR', error?.message ?? String(error));
    try { await transport?.disconnect(); } catch { /* best effort */ }
    transport = null;
    setButtons(false);
  }
}

async function disconnect() {
  app?.stopMonitoringLoop();
  app?.store.patch({ cardState: 'lost' });
  try { await transport?.disconnect(); } catch { /* best effort */ }
  transport = null;
  setConnection('DISCONNECTED', 'You disconnected from the card.');
  setButtons(false);
}

$('connectButton').addEventListener('click', connect);
$('disconnectButton').addEventListener('click', disconnect);

$('ackButton').addEventListener('click', () => {
  const result = app?.acknowledge();
  setText('actionResult', result?.ok ? 'Alert acknowledged (recorded on this page only).' : 'There is no active alert to acknowledge.');
});

$('actionButton').addEventListener('click', async () => {
  const alert = app?.store.get().lastAlert;
  if (!alert) return;
  const result = await app.actions.sendAction(alert);
  if (result.ok) {
    app.store.patch({ lastAlert: alert });
    setText('actionResult', result.sentToCard ? 'Command acknowledged by the card.' : 'Done on this page. Nothing was sent to the card.');
  } else {
    setText('actionResult', REASONS[result.reason] ?? `Not done: ${result.reason}`);
  }
});

$('detailsButton').addEventListener('click', () => {
  const state = app?.store.get();
  if (state?.lastAlert && renderer?.showDetail(state.lastAlert, state.lastSample)) $('detailClose').focus();
  else setText('actionResult', 'There is no alert to show yet.');
});
$('detailClose').addEventListener('click', () => renderer?.hideDetail());
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') renderer?.hideDetail(); });
$('soundToggle').addEventListener('change', (event) => { if (renderer) renderer.soundEnabled = event.target.checked; });

if (!isConfigured()) {
  setConnection('NOT CONFIGURED', 'No card protocol or field mapping is configured yet, so nothing can connect and no readings are shown. Capture the card frames first (see docs/CARD_PROTOCOL.md).');
}
setButtons(false);
