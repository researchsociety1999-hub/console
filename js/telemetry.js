// Telemetry models for the Joker modules.
// These are simulated generators by default; joker-adapter.js is the
// single place to swap in real hardware transport.

export function simulateThermal(prev) {
  const base = prev ?? 30;
  const next = Math.max(25, Math.min(40, base + (Math.random() - 0.45)));
  return Number(next.toFixed(1));
}

export function simulateWifi() {
  return {
    accessPoints: 5 + Math.floor(Math.random() * 6),
    frameRate: Math.floor(Math.random() * 60)
  };
}

export function simulateBle() {
  return { devices: 4 + Math.floor(Math.random() * 8) };
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
