// Module Detail: renders live controls/readouts for each Joker module
// inside the single #moduleDetail panel. Pure rendering here; app.js
// wires event handlers after inserting the returned HTML.

export function renderModuleDetailHtml(id, state) {
  switch (id) {
    case "nfc":
      return `
        <div class="line"><span>Events (last 5 min)</span><strong>${state.nfcEvents}</strong></div>
        <div class="line"><span>Reader</span><strong>PN532 &middot; 13.56 MHz (simulated)</strong></div>
        <p class="consent-note">Tag UIDs and payloads are never displayed in full; only event counts feed the dashboard and Watchdog.</p>
        <div class="actions">
          <button class="btn" data-action="rescan">Rescan Environment</button>
          <button class="btn" data-action="restart-module" data-module="nfc">Restart NFC</button>
        </div>`;
    case "wifi":
      return `
        <div class="line"><span>Access points</span><strong>${state.aps}</strong></div>
        <div class="line"><span>Mode</span><strong>Passive survey (observe-only)</strong></div>
        <p class="consent-note">No deauthentication, injection, or active probing is performed by this panel.</p>
        <div class="actions">
          <button class="btn" data-action="rescan">Rescan Environment</button>
          <button class="btn" data-action="restart-module" data-module="wifi">Restart Wi‑Fi</button>
        </div>`;
    case "ble":
      return `
        <div class="line"><span>Discovered devices</span><strong>${state.ble}</strong></div>
        <div class="line"><span>Mode</span><strong>Scanner (names / RSSI / service hints)</strong></div>
        <div class="actions">
          <button class="btn" data-action="rescan">Rescan Environment</button>
          <button class="btn" data-action="restart-module" data-module="ble">Restart BLE</button>
        </div>`;
    case "badusb":
      return `
        <p class="consent-note">Every action below requires an explicit confirmation dialog and is simulated unless a real Joker transport is connected in <code>js/joker-adapter.js</code>.</p>
        <div class="actions">
          <button class="btn" data-action="hack" data-label="Ducky-lite: open notes app">Preset: Open Notes</button>
          <button class="btn" data-action="hack" data-label="Ducky-lite: type diagnostic string">Preset: Type Diagnostic String</button>
          <button class="btn danger" data-action="hack" data-label="Ducky-lite: custom payload">Preset: Custom Payload</button>
        </div>`;
    case "gpio":
      return `
        <div class="line"><span>Pin 0</span><strong id="gpioPin0">LOW</strong></div>
        <div class="line"><span>Pin 1</span><strong id="gpioPin1">LOW</strong></div>
        <div class="line"><span>Pin 2</span><strong id="gpioPin2">LOW</strong></div>
        <div class="line"><span>Pin 3</span><strong id="gpioPin3">LOW</strong></div>
        <div class="actions">
          <button class="btn" data-action="gpio" data-pin="0">Toggle Pin 0</button>
          <button class="btn" data-action="gpio" data-pin="1">Toggle Pin 1</button>
          <button class="btn" data-action="gpio" data-pin="2">Toggle Pin 2</button>
          <button class="btn" data-action="gpio" data-pin="3">Toggle Pin 3</button>
        </div>`;
    case "rgb":
      return `
        <p class="consent-note">Selecting an effect sends a simulated RGB command to the Joker adapter and logs the action.</p>
        <div class="actions">
          <button class="btn" data-action="rgb" data-effect="idle-pulse">Idle Pulse</button>
          <button class="btn" data-action="rgb" data-effect="alert-sweep">Alert Sweep</button>
          <button class="btn" data-action="rgb" data-effect="rainbow">Rainbow</button>
          <button class="btn ghost-btn" data-action="rgb" data-effect="off">Off</button>
        </div>`;
    case "buzzer":
      return `
        <p class="consent-note">Test Tone plays a short beep using the Web Audio API in this browser tab (does not require hardware).</p>
        <div class="actions"><button class="btn" data-action="buzzer-test">Test Tone</button></div>`;
    case "storage":
      return `
        <div class="line"><span>Vault status</span><strong id="vaultDetailStatus">Locked</strong></div>
        <p class="consent-note">Unlock the vault from Settings with a passphrase, then use Export Intel / Clear Vault in Command Surface.</p>`;
    case "console":
      return `<p class="consent-note">Jump to the Console / Trusted Event Feed panel below for the live log and Ask Agent box.</p>
        <div class="actions"><button class="btn" data-action="scroll" data-target="log">Go to Console Feed</button></div>`;
    case "settings":
      return `<p class="consent-note">Jump to the Settings panel below to configure the Local Model, Cloud Agent, buzzer, and vault passphrase.</p>
        <div class="actions"><button class="btn" data-action="scroll" data-target="vaultPass">Go to Settings</button></div>`;
    default:
      return `<p class="consent-note">Select a module above to view its live controls and readouts.</p>`;
  }
}
