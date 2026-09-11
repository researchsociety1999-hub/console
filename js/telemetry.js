// Telemetry: per-module sample generation for all 10 Joker modules.
// 8 are hardware sensor/actuator modules (produce SensorData); Console and
// Settings are meta-modules handled directly by the UI layer.

export const HARDWARE_MODULES = ["nfc", "wifi", "ble", "badusb", "gpio", "rgb", "buzzer", "storage"];

// Module-level BLE novelty tracker. Exported directly so watchdog.js can
// inspect/reset it without duplicating device-identity state.
export const seenBle = new Set();

const BLE_DEVICE_POOL = Array.from({ length: 14 }, (_, i) => `BLE-${(1000 + i).toString(16).toUpperCase()}`);

function pick(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  }
  return out;
}

export function simulateThermal(prev) {
  const base = prev ?? 30;
  const next = Math.max(25, Math.min(40, base + (Math.random() - 0.45)));
  return Number(next.toFixed(1));
}

export function simulateWifi() {
  return { accessPoints: 5 + Math.floor(Math.random() * 6), frameRate: Math.floor(Math.random() * 60) };
}

/**
 * Simulates a BLE scan. Returns the visible device count plus, if a
 * previously-unseen device ID appears this cycle, that device's ID so the
 * caller (watchdog) can raise a BLE_NEW_DEVICE alert exactly once per ID.
 */
export function simulateBle() {
  const count = 3 + Math.floor(Math.random() * 7);
  const visible = pick(BLE_DEVICE_POOL, Math.min(count, BLE_DEVICE_POOL.length));
  let newDeviceId = null;
  for (const id of visible) {
    if (!seenBle.has(id)) {
      seenBle.add(id);
      newDeviceId = id;
      break; // surface one novelty event per cycle to avoid alert floods
    }
  }
  return { devices: visible.length, visibleIds: visible, newDeviceId };
}

export function simulateNfc() {
  return { eventsLast5Min: Math.floor(Math.random() * 4) };
}

export function simulateGpio(pins = 4) {
  return Array.from({ length: pins }, (_, i) => ({ pin: i, state: Math.random() > 0.5 ? "HIGH" : "LOW" }));
}

export function summarizeEnvironment(state) {
  const activity = state.wifi.frameRate > 40 || state.ble.devices > 9 ? "elevated" : "normal";
  return {
    wifiAccessPointCount: state.wifi.accessPoints,
    bleDeviceCount: state.ble.devices,
    nfcEventCountLast5Minutes: state.nfc.eventsLast5Min,
    wirelessActivityBand: activity
  };
}

export function synthesizeSensorFusion(overrides = {}) {
  const payload = {
    tempC: overrides.tempC ?? 32,
    batteryPercent: overrides.batteryPercent ?? 82,
    nfcUid: overrides.nfcUid ?? "NFC-UNKNOWN",
    wifiRssi: overrides.wifiRssi ?? -58,
    bleDeviceCount: overrides.bleDeviceCount ?? 0,
    timestamp: Date.now()
  };

  return {
    source_module: "fusion",
    ok: true,
    data_quality: "OK",
    timestamp: payload.timestamp,
    value: payload,
    sensorData: payload
  };
}

/**
 * Generates a single SensorData sample tagged with its originating module
 * AND a data_quality flag ("OK" | "DEGRADED"). Each hardware module has a
 * ~6% simulated failure chance so the Watchdog has real "module failure"
 * events to detect (per the 10/10 module mandate).
 *
 * @param {string} sourceModule - one of HARDWARE_MODULES
 * @returns {{source_module:string, value:any, ok:boolean, data_quality:string, timestamp:number}}
 */
export function generateSensorData(sourceModule) {
  const ok = Math.random() > 0.06;
  const data_quality = ok ? "OK" : "DEGRADED";
  const timestamp = Date.now();

  switch (sourceModule) {
    case "wifi":
      return { source_module: "wifi", value: ok ? simulateWifi() : null, ok, data_quality, timestamp };
    case "ble": {
      const ble = simulateBle();
      return { source_module: "ble", value: ok ? ble : null, ok, data_quality, timestamp, newDeviceId: ble.newDeviceId };
    }
    case "nfc":
      return { source_module: "nfc", value: ok ? simulateNfc() : null, ok, data_quality, timestamp };
    case "gpio":
      return { source_module: "gpio", value: ok ? simulateGpio() : null, ok, data_quality, timestamp };
    case "rgb":
      return { source_module: "rgb", value: ok ? { effect: "idle-pulse" } : null, ok, data_quality, timestamp };
    case "buzzer":
      return { source_module: "buzzer", value: ok ? { armed: true } : null, ok, data_quality, timestamp };
    case "storage":
      return { source_module: "storage", value: ok ? { freeBytesApprox: 900000 + Math.floor(Math.random() * 100000) } : null, ok, data_quality, timestamp };
    case "badusb":
      return { source_module: "badusb", value: ok ? { armed: true } : null, ok, data_quality, timestamp };
    default:
      return { source_module: sourceModule, value: null, ok: false, data_quality: "DEGRADED", timestamp };
  }
}
