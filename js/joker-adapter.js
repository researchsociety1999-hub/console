// Joker Adapter: the single extension point for real hardware transport.
// By default this module simulates a Joker Card session across all 8
// hardware modules. Replace the internals with Web Bluetooth / Web Serial /
// a local gateway call when real hardware is available. HID/BadUSB actions
// remain confirmation-gated at the UI layer regardless of transport.

import { simulateThermal, generateSensorData, HARDWARE_MODULES } from "./telemetry.js";

export class JokerAdapter {
  constructor() {
    this.connected = false;
    this.transport = "simulated";
    this.thermal = 30;
  }

  async connect() {
    await new Promise((r) => setTimeout(r, 300));
    this.connected = true;
    return { connected: true, transport: this.transport };
  }

  disconnect() {
    this.connected = false;
  }

  /** Legacy aggregate sample used by the hero/signals panels. */
  sample() {
    if (!this.connected) return null;
    this.thermal = simulateThermal(this.thermal);
    const wifi = generateSensorData("wifi").value || { accessPoints: 0, frameRate: 0 };
    const bleSample = generateSensorData("ble");
    const ble = bleSample.value || { devices: 0, visibleIds: [], newDeviceId: null };
    const nfc = generateSensorData("nfc").value || { eventsLast5Min: 0 };
    const gpio = generateSensorData("gpio").value || [];
    return { thermal: this.thermal, wifi, ble, nfc, gpio, bleNewDeviceId: bleSample.newDeviceId };
  }

  /**
   * Samples every one of the 8 hardware modules and tags each result with
   * its source_module, for the Watchdog's per-module health checks.
   * @returns {Array<{source_module:string, value:any, ok:boolean, timestamp:number}>}
   */
  sampleAllModules() {
    if (!this.connected) return [];
    return HARDWARE_MODULES.map((moduleName) => generateSensorData(moduleName));
  }

  // ---- Confirmation-gated action surface (UI must confirm before calling) ----

  async runQuickHack(label) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "QUICK_HACK", label, status: "simulated", executedAt: Date.now() };
  }

  async setGpioPin(pin, value) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "GPIO_SET", pin, value, status: "simulated", executedAt: Date.now() };
  }

  /** Dedicated RGB Aura control (per module-integration mandate). */
  async setRgbMode(mode) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "RGB_MODE", mode, status: "simulated", executedAt: Date.now() };
  }

  /** Dedicated Buzzer control: frequency in Hz, duration in ms. */
  async sendBuzzerTone(freq = 880, duration = 180) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "BUZZER_TONE", freq, duration, status: "simulated", executedAt: Date.now() };
  }

  /** Backwards-compatible aliases used by earlier UI wiring. */
  async setRgbEffect(effect) {
    return this.setRgbMode(effect);
  }

  async triggerBuzzer(pattern) {
    return this.sendBuzzerTone(880, 180);
  }

  /**
   * Attempts to restart a failed module (simulated). Used by the
   * RESTART_MODULE:<name> action-recommendation pathway.
   */
  async restartModule(moduleName) {
    if (!this.connected) throw new Error("Joker not connected");
    await new Promise((r) => setTimeout(r, 200));
    const recovered = Math.random() > 0.2;
    return { action: "MODULE_RESTART", module: moduleName, recovered, status: "simulated", executedAt: Date.now() };
  }
}
