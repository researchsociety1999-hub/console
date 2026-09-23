export class JokerAdapter {
  constructor() {
    this.connected = false;
    this.transport = 'Simulated';
    this.moduleStates = {};
    this.gpioState = {};
    this._ambientBaseline = 27 + Math.random() * 2;
    this._driftPhase = Math.random() * Math.PI * 2;
    this._heatSources = [{ row: 3, col: 5, intensity: 3.2 }];
    this._thermalHistory = [];
    this._gpioLines = {
      doorContact: { active: false, activity: 0, lastChangedAt: null },
      pirMotion: { active: false, activity: 0, lastChangedAt: null },
      vibrationTamper: { active: false, activity: 0, lastChangedAt: null }
    };
    this._wiegandActivity = { d0: 0, d1: 0 };
    this._bleDiscovered = new Set();
    this._nfcReader = null;
    this._nfcEventTimestamps = [];
    this._selfTestCounter = 0;
  }

  async connect(profile = {}) {
    this.connected = true;
    this.transport = profile.transport || 'Simulated';
    return { status: 'CONNECTED', transport: this.transport };
  }

  async disconnect() {
    this.connected = false;
    this.stopNfcReaderSession();
    return { status: 'DISCONNECTED' };
  }

  async sample() {
    if (!this.connected) return null;
    const grid = this.generateThermalGrid();
    const centerValue = grid[Math.floor(grid.length / 2)];
    return {
      thermal: Number(centerValue.toFixed(2)),
      wifi: { accessPoints: Math.floor(Math.random() * 10) + 1 },
      ble: { devices: this._bleDiscovered.size || Math.floor(Math.random() * 5) },
      nfc: { eventsLast5Min: this._countRecentNfcEvents() },
      modules: [
        { id: 'nfc', status: 'OK' },
        { id: 'gpio', status: 'OK' }
      ]
    };
  }

  generateThermalGrid(rows = 8, cols = 8) {
    this._driftPhase += 0.05;
    const ambient = this._ambientBaseline + Math.sin(this._driftPhase) * 0.4 + (Math.random() - 0.5) * 0.15;
    const grid = new Array(rows * cols).fill(0);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let value = ambient;
        for (const source of this._heatSources) {
          const dr = r - source.row;
          const dc = c - source.col;
          const distanceSq = dr * dr + dc * dc;
          value += source.intensity * Math.exp(-distanceSq / 3);
        }
        value += (Math.random() - 0.5) * 0.3;
        grid[r * cols + c] = value;
      }
    }
    this._thermalHistory.push(grid);
    if (this._thermalHistory.length > 20) this._thermalHistory.shift();
    return grid;
  }

  addHeatSource(row, col, intensity = 3) {
    const source = { row, col, intensity };
    this._heatSources.push(source);
    return { ...source };
  }

  clearHeatSources() { this._heatSources = []; }

  calibrateThermalBaseline(sampleCount = 5) {
    const frames = [];
    for (let i = 0; i < sampleCount; i++) frames.push(this.generateThermalGrid());
    const flatValues = frames.flat();
    const baseline = flatValues.reduce((sum, v) => sum + v, 0) / flatValues.length;
    this._ambientBaseline = baseline;
    return baseline;
  }

  async getSafeAuditTelemetry() {
    if (!this.connected) return null;
    const grid = this.generateThermalGrid();
    return {
      thermalGrid: grid,
      gpio: {
        doorContact: this._gpioLines.doorContact.active,
        pirMotion: this._gpioLines.pirMotion.active,
        vibrationTamper: this._gpioLines.vibrationTamper.active,
        wiegandD0Activity: this._wiegandActivity.d0,
        wiegandD1Activity: this._wiegandActivity.d1
      }
    };
  }

  toggleGpioLine(lineName) {
    const line = this._gpioLines[lineName];
    if (!line) throw new Error(`Unknown GPIO line: ${lineName}`);
    line.active = !line.active;
    line.activity += 1;
    line.lastChangedAt = new Date().toISOString();
    return { line: lineName, active: line.active, activity: line.activity };
  }

  getGpioSnapshot() {
    return Object.fromEntries(Object.entries(this._gpioLines).map(([key, value]) => [key, { ...value }]));
  }

  serializeSafeAuditEvent(type, data = {}) {
    const allowed = ['THERMAL_SCAN', 'GPIO_STATUS', 'NFC_CLASSIFICATION', 'ASSET_ASSESSMENT'];
    if (!allowed.includes(type)) throw new Error('Unsupported safe audit event type.');
    const safe = { type, timestamp: new Date().toISOString(), data: { ...data } };
    delete safe.data.wiegandPayload;
    delete safe.data.cardUid;
    delete safe.data.credential;
    return JSON.stringify(safe);
  }

  parseSafeAuditEvent(payload) {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!parsed || typeof parsed !== 'object' || !parsed.type) throw new Error('Invalid safe audit event payload.');
    return this.serializeSafeAuditEvent(parsed.type, parsed.data || {});
  }

  setGpioPin(pin, value) {
    if (!this.connected) throw new Error('Connect local hardware before setting GPIO state.');
    const pinId = String(pin);
    const normalizedValue = value === true || value === 'HIGH' || value === 1 ? 'HIGH' : 'LOW';
    this.gpioState[pinId] = normalizedValue;
    return { pin: pinId, value: normalizedValue, status: 'SET_LOCALLY' };
  }

  setModuleState(moduleId, state) {
    if (!this.connected) throw new Error('Connect local hardware before toggling a module.');
    const id = String(moduleId || 'unknown');
    const normalizedState = state === true || state === 'ON' ? 'ON' : 'OFF';
    this.moduleStates[id] = normalizedState;
    return { moduleId: id, state: normalizedState, status: 'SET_LOCALLY' };
  }

  toggleModule(moduleId, state) { return this.setModuleState(moduleId, state); }

  async triggerModuleSelfTest(moduleId) {
    if (!this.connected) throw new Error('Connect local hardware before running a self-test.');
    this._selfTestCounter += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const latencyMs = 8 + Math.round(Math.random() * 40);
    const passed = latencyMs < 45;
    return { moduleId: String(moduleId || 'unknown'), passed, latencyMs, runCount: this._selfTestCounter };
  }

  async scanForBleDevice() {
    if (typeof navigator === 'undefined' || !navigator.bluetooth?.requestDevice) {
      return { supported: false, devices: this._simulateBleCount() };
    }
    try {
      const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
      this._bleDiscovered.add(device.id || device.name || `device-${this._bleDiscovered.size + 1}`);
      if (typeof device.watchAdvertisements === 'function') {
        try { await device.watchAdvertisements(); } catch { /* optional presence tracking */ }
      }
      return { supported: true, devices: this._bleDiscovered.size, deviceName: device.name || 'Unnamed device' };
    } catch (error) {
      return { supported: true, cancelled: true, devices: this._bleDiscovered.size || this._simulateBleCount(), error: error.message };
    }
  }

  _simulateBleCount() { return Math.floor(Math.random() * 5); }

  async startNfcReaderSession(onReading) {
    if (typeof NDEFReader === 'undefined') return { supported: false };
    try {
      this._nfcReader = new NDEFReader();
      await this._nfcReader.scan();
      this._nfcReader.onreading = (event) => {
        this._nfcEventTimestamps.push(Date.now());
        const techSummary = {
          serialNumberPresent: Boolean(event.serialNumber),
          recordTypes: (event.message?.records || []).map((record) => record.recordType)
        };
        if (typeof onReading === 'function') onReading(techSummary);
      };
      return { supported: true };
    } catch (error) {
      return { supported: true, error: error.message };
    }
  }

  stopNfcReaderSession() { this._nfcReader = null; }

  _countRecentNfcEvents(windowMs = 5 * 60 * 1000) {
    const now = Date.now();
    this._nfcEventTimestamps = this._nfcEventTimestamps.filter((t) => now - t <= windowMs);
    return this._nfcEventTimestamps.length || Math.floor(Math.random() * 3);
  }

  getRadarScanData() {
    const bleCount = this._bleDiscovered.size || Math.floor(Math.random() * 4) + 1;
    const wifiCount = Math.floor(Math.random() * 6) + 2;
    const devices = [];
    for (let i = 0; i < bleCount; i++) {
      devices.push({ angle: Math.random() * Math.PI * 2, rssi: -40 - Math.random() * 50, kind: 'BLE', safety: i === 0 ? 'KNOWN' : 'UNKNOWN' });
    }
    for (let i = 0; i < wifiCount; i++) {
      devices.push({ angle: Math.random() * Math.PI * 2, rssi: -30 - Math.random() * 60, kind: 'WIFI', safety: 'UNKNOWN' });
    }
    return devices;
  }
}
