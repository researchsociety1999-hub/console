/**
 * JokerAdapter - Local Hardware Interface & Hardware Simulation Bus
 */

export class JokerAdapter {
  constructor() {
    this.connected = false;
    this.activeProfile = 'default';
    this.telemetryBus = {
      thermal: Array(64).fill(22.5),
      gpio: Array(14).fill(0),
      rssi: -65
    };
  }

  async connect() {
    this.connected = true;
    return { success: true, status: 'CONNECTED' };
  }

  async disconnect() {
    this.connected = false;
    return { success: true, status: 'DISCONNECTED' };
  }

  getThermalGrid() {
    return Array.isArray(this.telemetryBus?.thermal)
      ? this.telemetryBus.thermal
      : [];
  }

  getRadarScanData() {
    return {
      angle: Math.floor(Math.random() * 360),
      devices: [
        { id: 'ble-node-01', rssi: -45, type: 'BLE', safe: true },
        { id: 'wifi-ap-02', rssi: -72, type: 'Wi-Fi', safe: false }
      ]
    };
  }

  /**
   * Sets the active local hardware or connection profile.
   */
  setProfile(profileName) {
    this.activeProfile = profileName || 'default';
    return { success: true, profile: this.activeProfile };
  }

  /**
   * Isolates the simulated device and clears its connected state.
   */
  killDevice() {
    this.connected = false;
    this.activeProfile = 'isolated';
    return { success: true, status: 'TERMINATED' };
  }
}

if (typeof window !== 'undefined') {
  window.jokerAdapter = window.jokerAdapter || new JokerAdapter();
}
