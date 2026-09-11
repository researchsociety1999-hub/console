// Joker Adapter — Real Hardware (Web Bluetooth BLE GATT / Wi‑Fi / Custom PCB)
// + Simulation Fallback
//
// The UI toggle switches between simulation and physical transports without
// changing the Firewall, Watchdog, Vault, or HUD code.
//
// Browser requirements for BLE:
// - Secure context (HTTPS or localhost)
// - Chromium-based browser with Web Bluetooth (Chrome/Edge/Brave)
// - The Joker Card must expose the specified custom BLE GATT service

import {
  simulateThermal,
  generateSensorData,
  HARDWARE_MODULES
} from "./telemetry.js";

export const JOKER_SERVICE_UUID = "00000000-0000-0000-0000-000000000001";
export const SENSOR_DATA_CHARACTERISTIC_UUID = "00000000-0000-0000-0000-000000000002";
export const COMMAND_CHARACTERISTIC_UUID = "00000000-0000-0000-0000-000000000003";
export const DEVICE_STATUS_CHARACTERISTIC_UUID = "00000000-0000-0000-0000-000000000004";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class JokerAdapter {
  constructor() {
    this.connected = false;
    this.transport = "simulated";
    this.mode = "simulated";
    this.thermal = 30;
    this.stealthMode = false;
    this.isPoweredOff = false;
    this.connectionProfile = {
      transport: "simulated",
      boardType: "SGP Joker Card",
      deviceName: "SGP Joker Card",
      endpointUrl: "",
      wifiSsid: "",
      wifiPassword: ""
    };

    this.device = null;
    this.server = null;
    this.service = null;
    this.sensorCharacteristic = null;
    this.commandCharacteristic = null;
    this.statusCharacteristic = null;

    this.latestModuleSamples = new Map();
    this.latestThermal = null;
    this.lastHardwarePacketAt = 0;
    this._onNotification = this._onNotification.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  /**
   * Read-only view of Stealth Mode state, exposed as a dedicated property
   * (in addition to the underlying `stealthMode` field kept for backward
   * compatibility with existing callers/tests).
   */
  get isStealthModeActive() {
    return this.stealthMode === true;
  }

  get canUseWebBluetooth() {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  setProfile(profile = {}) {
    const next = {
      transport: profile.transport || this.connectionProfile.transport || "simulated",
      boardType: profile.boardType || this.connectionProfile.boardType || "SGP Joker Card",
      deviceName: profile.deviceName || this.connectionProfile.deviceName || "SGP Joker Card",
      endpointUrl: profile.endpointUrl || "",
      wifiSsid: profile.wifiSsid || "",
      wifiPassword: profile.wifiPassword || ""
    };

    if (!["simulated", "ble", "wifi", "custom"].includes(next.transport)) {
      throw new Error(`Unsupported adapter transport: ${next.transport}`);
    }

    this.connectionProfile = next;
    this.transport = next.transport === "ble" ? "ble-gatt" : next.transport === "wifi" ? "wifi" : next.transport === "custom" ? "custom" : "simulated";
    this.mode = next.transport === "ble" ? "ble" : next.transport === "wifi" || next.transport === "custom" ? "simulated" : "simulated";
    return this.connectionProfile;
  }

  validateConnectionProfile() {
    const profile = this.connectionProfile;
    const transport = profile.transport || "simulated";

    if (transport === "simulated") {
      return { valid: true, warnings: [] };
    }

    if (transport === "ble") {
      const valid = Boolean(profile.deviceName && profile.deviceName.trim());
      return { valid, warnings: valid ? [] : ["Enter a device name for BLE connection."] };
    }

    if (transport === "wifi" || transport === "custom") {
      const valid = Boolean(profile.endpointUrl && profile.endpointUrl.trim()) || Boolean(profile.wifiSsid && profile.wifiSsid.trim());
      return { valid, warnings: valid ? [] : ["Enter either an endpoint URL or Wi\u2011Fi SSID for a custom board connection."] };
    }

    return { valid: false, warnings: ["Unsupported transport selected."] };
  }

  setMode(mode) {
    if (!["simulated", "ble", "wifi", "custom"].includes(mode)) {
      throw new Error(`Unsupported adapter mode: ${mode}`);
    }
    if (mode === "ble" && !this.canUseWebBluetooth) {
      this.mode = "simulated";
      this.transport = "simulated";
      return false;
    }
    this.mode = mode;
    this.transport = mode === "ble" ? "ble-gatt" : mode === "wifi" ? "wifi" : mode === "custom" ? "custom" : "simulated";
    this.connectionProfile.transport = mode;
    return true;
  }

  async connect() {
    const profileValidation = this.validateConnectionProfile();
    if (!profileValidation.valid && this.connectionProfile.transport !== "simulated") {
      throw new Error(profileValidation.warnings[0] || "The selected connection profile is incomplete.");
    }

    if (this.mode === "simulated" || this.connectionProfile.transport === "simulated") {
      await new Promise((resolve) => setTimeout(resolve, 300));
      this.connected = true;
      this.transport = "simulated";
      this.isPoweredOff = false;
      return { connected: true, transport: this.transport, mode: this.mode, profile: { ...this.connectionProfile } };
    }

    if (!this.canUseWebBluetooth) {
      throw new Error(
        "Web Bluetooth is unavailable in this browser. Use a Chromium browser over HTTPS or switch to Simulation."
      );
    }

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [JOKER_SERVICE_UUID] }],
      optionalServices: [JOKER_SERVICE_UUID]
    });

    this.device.addEventListener("gattserverdisconnected", this._onDisconnected);
    this.server = await this.device.gatt.connect();
    this.service = await this.server.getPrimaryService(JOKER_SERVICE_UUID);

    this.sensorCharacteristic = await this.service.getCharacteristic(SENSOR_DATA_CHARACTERISTIC_UUID);
    this.commandCharacteristic = await this.service.getCharacteristic(COMMAND_CHARACTERISTIC_UUID);

    try {
      this.statusCharacteristic = await this.service.getCharacteristic(DEVICE_STATUS_CHARACTERISTIC_UUID);
    } catch {
      this.statusCharacteristic = null;
    }

    await this.sensorCharacteristic.startNotifications();
    this.sensorCharacteristic.addEventListener("characteristicvaluechanged", this._onNotification);

    this.connected = true;
    this.transport = "ble-gatt";
    this.isPoweredOff = false;

    await this._readInitialStatus();

    return {
      connected: true,
      transport: this.transport,
      mode: this.mode,
      name: this.device.name || "SGP Joker Card"
    };
  }

  disconnect() {
    if (this.sensorCharacteristic) {
      try {
        this.sensorCharacteristic.removeEventListener("characteristicvaluechanged", this._onNotification);
      } catch {}
    }
    if (this.device) {
      try {
        this.device.removeEventListener("gattserverdisconnected", this._onDisconnected);
      } catch {}
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    }
    this.connected = false;
    this.server = null;
    this.service = null;
    this.sensorCharacteristic = null;
    this.commandCharacteristic = null;
    this.statusCharacteristic = null;
    this.device = null;
  }

  _onDisconnected() {
    this.connected = false;
    this.server = null;
    this.service = null;
    this.sensorCharacteristic = null;
    this.commandCharacteristic = null;
    this.statusCharacteristic = null;
  }

  _onNotification(event) {
    try {
      const raw = textDecoder.decode(event.target.value);
      const parsed = JSON.parse(raw);

      if (!parsed?.source_module || !HARDWARE_MODULES.includes(parsed.source_module)) {
        console.warn("Ignored unrecognized Joker telemetry packet", parsed);
        return;
      }

      const normalized = {
        source_module: parsed.source_module,
        value: parsed.value ?? null,
        ok: parsed.ok !== false,
        data_quality: parsed.data_quality === "DEGRADED" ? "DEGRADED" : "OK",
        timestamp: Number.isFinite(parsed.timestamp) ? parsed.timestamp : Date.now(),
        newDeviceId: parsed.newDeviceId ?? parsed.value?.newDeviceId ?? null
      };

      this.latestModuleSamples.set(normalized.source_module, normalized);
      this.lastHardwarePacketAt = Date.now();

      if (normalized.source_module === "thermal" && typeof normalized.value === "number") {
        this.latestThermal = normalized.value;
      }
      if (typeof normalized.value?.temperatureC === "number") {
        this.latestThermal = normalized.value.temperatureC;
      }
    } catch (error) {
      console.warn("Failed to parse Joker BLE telemetry packet", error);
    }
  }

  async _readInitialStatus() {
    if (!this.statusCharacteristic) return null;
    try {
      const value = await this.statusCharacteristic.readValue();
      const status = JSON.parse(textDecoder.decode(value));
      if (typeof status.temperatureC === "number") this.latestThermal = status.temperatureC;
      return status;
    } catch {
      return null;
    }
  }

  sample() {
    if (!this.connected) return null;

    if (this.mode === "simulated") {
      this.thermal = simulateThermal(this.thermal);
      const wifi = generateSensorData("wifi").value || { accessPoints: 0, frameRate: 0 };
      const bleSample = generateSensorData("ble");
      const ble = bleSample.value || { devices: 0, visibleIds: [], newDeviceId: null };
      const nfc = generateSensorData("nfc").value || { eventsLast5Min: 0 };
      const gpio = generateSensorData("gpio").value || [];
      return { thermal: this.thermal, wifi, ble, nfc, gpio, bleNewDeviceId: bleSample.newDeviceId };
    }

    const wifi = this.latestModuleSamples.get("wifi")?.value || { accessPoints: 0, frameRate: 0 };
    const ble = this.latestModuleSamples.get("ble")?.value || { devices: 0, visibleIds: [], newDeviceId: null };
    const nfc = this.latestModuleSamples.get("nfc")?.value || { eventsLast5Min: 0 };
    const gpio = this.latestModuleSamples.get("gpio")?.value || [];

    return {
      thermal: this.latestThermal,
      wifi,
      ble,
      nfc,
      gpio,
      bleNewDeviceId: this.latestModuleSamples.get("ble")?.newDeviceId ?? ble.newDeviceId ?? null
    };
  }

  sampleAllModules() {
    if (!this.connected) return [];

    if (this.mode === "simulated") {
      return HARDWARE_MODULES.map((moduleName) => {
        if (this.stealthMode && ["rgb", "buzzer", "wifi"].includes(moduleName)) {
          return { source_module: moduleName, value: null, ok: true, data_quality: "OK", disabled: true, timestamp: Date.now() };
        }
        return generateSensorData(moduleName);
      });
    }

    return HARDWARE_MODULES.map((moduleName) => {
      if (this.stealthMode && ["rgb", "buzzer", "wifi"].includes(moduleName)) {
        return { source_module: moduleName, value: null, ok: true, data_quality: "OK", disabled: true, timestamp: Date.now() };
      }
      return this.latestModuleSamples.get(moduleName) || {
        source_module: moduleName,
        value: null,
        ok: false,
        data_quality: "DEGRADED",
        timestamp: Date.now()
      };
    });
  }

  async _sendCommand(action, payload = {}) {
    if (!this.connected) throw new Error("Joker not connected");

    if (this.mode === "simulated") {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return { action, payload, status: "simulated", executedAt: Date.now() };
    }

    if (!this.commandCharacteristic) throw new Error("Joker command characteristic is unavailable");

    const command = {
      id: crypto.randomUUID?.() ?? `cmd-${Date.now()}`,
      action,
      payload,
      timestamp: Date.now()
    };

    const bytes = textEncoder.encode(JSON.stringify(command));
    await this.commandCharacteristic.writeValueWithResponse(bytes);
    return { action, payload, status: "sent", executedAt: Date.now(), commandId: command.id };
  }

  async runQuickHack(label) {
    return this._sendCommand("QUICK_HACK", { label });
  }

  async setGpioPin(pin, value) {
    return this._sendCommand("GPIO_SET", { pin, value });
  }

  async setRgbMode(mode) {
    if (this.stealthMode) return { action: "RGB_MODE", mode, status: "suppressed_by_stealth_mode", executedAt: Date.now() };
    return this._sendCommand("RGB_MODE", { mode });
  }

  async sendBuzzerTone(freq = 880, duration = 180) {
    if (this.stealthMode) return { action: "BUZZER_TONE", freq, duration, status: "suppressed_by_stealth_mode", executedAt: Date.now() };
    return this._sendCommand("BUZZER_TONE", { freq, duration });
  }

  async setRgbEffect(effect) {
    return this.setRgbMode(effect);
  }

  async triggerBuzzer() {
    return this.sendBuzzerTone(880, 180);
  }

  async restartModule(moduleName) {
    const success = Math.random() > 0.15;
    const result = await this._sendCommand("MODULE_RESTART", { module: moduleName });
    return { ...result, recovered: success };
  }

  async setStealthMode(enabled) {
    this.stealthMode = !!enabled;
    if (!this.connected || this.mode === "simulated") {
      return { action: "STEALTH_MODE", enabled: this.stealthMode, status: "simulated", executedAt: Date.now() };
    }
    return this._sendCommand("STEALTH_MODE", { enabled: this.stealthMode, disable: ["rgb", "buzzer", "wifi"] });
  }

  /**
   * Hard Kill Switch — puts the Joker Card into deep-sleep isolation.
   * Requires explicit operator confirmation. Sets isPoweredOff = true and
   * always returns the resulting alert (severity kept lowercase "critical"
   * to match the live UI's SEV_THEME lookup table).
   */
  async killDevice({ confirmed = false } = {}) {
    if (!confirmed) {
      return {
        success: false,
        requiresConfirmation: true,
        alert: {
          type: "POWER_LOSS",
          severity: "high",
          message: "Hardware isolation requires explicit operator confirmation.",
          predicted_state: "AWAITING_CONFIRMATION",
          recommendation: "FLAG_FOR_REVIEW",
          is_critical_leak: false,
          createdAt: Date.now()
        }
      };
    }

    const command = { action: "DEEP_SLEEP", payload: { reason: "operator_confirmed_hardware_isolation" } };

    if (this.mode === "ble" && this.commandCharacteristic) {
      await this._sendCommand(command.action, command.payload);
    }

    this.isPoweredOff = true;
    this.connected = false;
    this.disconnect();

    const alert = {
      type: "POWER_LOSS",
      severity: "critical",
      message: "Joker Card entered isolated deep-sleep mode.",
      predicted_state: "OFFLINE",
      recommendation: "FLAG_FOR_REVIEW",
      is_critical_leak: true,
      createdAt: Date.now()
    };

    return { success: true, alert };
  }

  isDevicePoweredOff() {
    return this.isPoweredOff === true;
  }
}

// Note: app.js instantiates its own `new JokerAdapter()` and does not use
// this default export. Keep it only for standalone/test usage.
const jokerAdapter = new JokerAdapter();
export default jokerAdapter;
