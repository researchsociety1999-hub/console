// Joker Adapter: the single extension point for real hardware transport.
// By default this module simulates a Joker Card session. Replace the
// internals with Web Bluetooth / Web Serial / a local gateway call when
// real hardware is available. Never execute HID/BadUSB payloads without
// explicit, per-action user confirmation in the UI layer.

import { simulateThermal, simulateWifi, simulateBle, simulateNfc, simulateGpio } from "./telemetry.js";

export class JokerAdapter {
  constructor() {
    this.connected = false;
    this.thermal = 30;
  }

  async connect() {
    // Real implementation: negotiate a Web Bluetooth/Serial session here.
    await new Promise((r) => setTimeout(r, 300));
    this.connected = true;
    return { connected: true, transport: "simulated" };
  }

  disconnect() {
    this.connected = false;
  }

  sample() {
    if (!this.connected) return null;
    this.thermal = simulateThermal(this.thermal);
    return {
      thermal: this.thermal,
      wifi: simulateWifi(),
      ble: simulateBle(),
      nfc: simulateNfc(),
      gpio: simulateGpio()
    };
  }

  // Confirmation-gated action surface. The UI must obtain explicit user
  // confirmation before calling any of these on real hardware.
  async runQuickHack(label) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "QUICK_HACK", label, status: "simulated", executedAt: Date.now() };
  }

  async setGpioPin(pin, value) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "GPIO_SET", pin, value, status: "simulated", executedAt: Date.now() };
  }

  async setRgbEffect(effect) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "RGB_SET", effect, status: "simulated", executedAt: Date.now() };
  }

  async triggerBuzzer(pattern) {
    if (!this.connected) throw new Error("Joker not connected");
    return { action: "BUZZER", pattern, status: "simulated", executedAt: Date.now() };
  }
}
