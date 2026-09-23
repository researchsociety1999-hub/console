export class JokerAdapter {
  constructor() {
    this.connected = false;
    this.transport = 'Simulated';
  }

  async connect(profile = {}) {
    this.connected = true;
    this.transport = profile.transport || 'Simulated';
    return { status: 'CONNECTED', transport: this.transport };
  }

  async disconnect() {
    this.connected = false;
    return { status: 'DISCONNECTED' };
  }

  async sample() {
    if (!this.connected) return null;
    return {
      thermal: 28.5 + (Math.random() * 2 - 1),
      wifi: { accessPoints: Math.floor(Math.random() * 10) + 1 },
      ble: { devices: Math.floor(Math.random() * 5) },
      nfc: { eventsLast5Min: Math.floor(Math.random() * 3) },
      modules: [
        { id: 'nfc', status: 'OK' },
        { id: 'gpio', status: 'OK' }
      ]
    };
  }

  async getSafeAuditTelemetry() {
    if (!this.connected) return null;
    const baseline = 28 + Math.random();
    return {
      thermalGrid: Array.from({ length: 16 }, (_, index) => baseline + (index === 10 ? 3.1 : Math.random() * 1.2)),
      gpio: {
        doorContact: Math.random() > 0.1,
        pirMotion: Math.random() > 0.85,
        vibrationTamper: false,
        wiegandD0Activity: Math.floor(Math.random() * 3),
        wiegandD1Activity: Math.floor(Math.random() * 3)
      }
    };
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
}
