function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 16777619); }
  return `local-fallback-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

const MODULE_FIELDS = {
  wifi: ['accessPoints', 'frameRate'],
  thermal: ['temperatureC'],
  ble: ['newDeviceId'],
  nfc: ['eventsLast5Min'],
  gpio: ['doorContact', 'pirMotion', 'vibrationTamper']
};

export function sanitizeValue(module, value = {}) {
  const fields = MODULE_FIELDS[module] || Object.keys(value);
  return Object.fromEntries(fields.filter((key) => Object.prototype.hasOwnProperty.call(value, key)).map((key) => [key, value[key]]));
}

export function validateModulePacket(packet) {
  return Boolean(packet && typeof packet === 'object' && MODULE_FIELDS[packet.source_module] && typeof packet.ok === 'boolean' && ['OK', 'DEGRADED', 'ERROR'].includes(packet.data_quality) && Number.isFinite(packet.timestamp) && packet.value && typeof packet.value === 'object');
}

export function computeTrustScore(packet) {
  if (!validateModulePacket(packet)) return 0;
  const age = Math.max(0, Date.now() - packet.timestamp);
  return Math.max(0, Math.min(1, (packet.data_quality === 'OK' ? 1 : 0.55) - Math.min(age / 120000, 0.8)));
}

export function deriveCardState(packets = []) {
  const valid = packets.filter(validateModulePacket);
  if (!valid.length) return 'OFFLINE';
  if (valid.some((packet) => packet.source_module === 'thermal' && Number(packet.value.temperatureC) >= 80)) return 'LOST';
  return 'ONLINE';
}

export function isActionApproved(action) {
  return new Set(['RGB_MODE', 'BUZZER_TONE', 'GPIO_SET', 'MODULE_RESTART']).has(action);
}

export async function dispatchApprovedCommand(adapter, action, params = {}) {
  if (!isActionApproved(action)) throw new Error('Action is not approved.');
  const handlers = { RGB_MODE: () => adapter.setRgbMode(params.mode), BUZZER_TONE: () => adapter.sendBuzzerTone(params), GPIO_SET: () => adapter.setGpioPin(params.pin, params.value), MODULE_RESTART: () => adapter.restartModule(params.moduleId) };
  return handlers[action]();
}

export function runDataFirewall(packet, context = {}) {
  if (!context.connected) return { packet: null, context: { ...context, reason: 'DEVICE_NOT_CONNECTED' }, alert: { type: 'DEVICE_NOT_CONNECTED', level: 'HIGH' } };
  if (!validateModulePacket(packet)) return { packet: null, context: { ...context, reason: 'INVALID_PACKET' }, alert: { type: 'INVALID_PACKET', level: 'HIGH' } };
  return { packet: { ...packet, value: sanitizeValue(packet.source_module, packet.value), trust: computeTrustScore(packet) }, context, alert: null };
}

export class DataFirewall {
  constructor() { this.alerts = []; }
  generateAlert(telemetry) {
    const alerts = [];
    if (telemetry.thermal > 40.0) alerts.push({ level: 'CRITICAL', type: 'THERMAL_EXCEEDED', value: telemetry.thermal });
    if (telemetry.nfc && telemetry.nfc.eventsLast5Min > 10) alerts.push({ level: 'HIGH', type: 'NFC_BURST', value: telemetry.nfc.eventsLast5Min });
    this.alerts.push(...alerts); return alerts;
  }
}

export class SecurityAuditFirewall extends DataFirewall {
  constructor({ vault = null, expectedPin = null } = {}) { super(); this.vault = vault; this.expectedPin = expectedPin; this.authorized = false; this.authorizationReference = null; this.auditLog = []; this.previousHash = 'GENESIS'; this.transientKey = null; }
  sanitizeMetadata(value) { const pattern = /(pin|pass(word|phrase)?|secret|token|credential|key|payload|uid|card.?data)/i; if (Array.isArray(value)) return value.map((item) => this.sanitizeMetadata(item)); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, pattern.test(key) ? '[REDACTED]' : this.sanitizeMetadata(item)])); if (typeof value === 'string' && value.length > 512) return '[TRUNCATED]'; return value; }
  async verifyAuthorization(authTicket, adminPIN, acknowledged = false) { const ticket = String(authTicket || '').trim(); const pin = String(adminPIN || ''); const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(ticket) && pin.length >= 6 && pin.length <= 256 && (!this.expectedPin || pin === this.expectedPin); if (!acknowledged || !valid) return { authorized: false, reason: 'A valid local ticket, passphrase, and acknowledgment are required.' }; this.authorized = true; this.authorizationReference = ticket; this.transientKey = await sha256(`${ticket}:${Date.now()}:${Math.random()}`); await this.logEvent('SESSION_START', { acknowledgment: true, authorizationTicket: ticket }); return { authorized: true, reference: ticket }; }
  async logEvent(action, data = {}) { if (!this.authorized && action !== 'SESSION_START') throw new Error('Audit session is locked. Verify authorization first.'); const entry = { timestamp: new Date().toISOString(), action: String(action || 'UNSPECIFIED').replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 96), authorizationReference: this.authorizationReference, metadata: this.sanitizeMetadata(data), previousHash: this.previousHash }; entry.integrityHash = await sha256(stableStringify(entry)); this.previousHash = entry.integrityHash; this.auditLog.push(entry); if (this.vault?.isUnlocked && typeof this.vault.store === 'function') await this.vault.store({ type: 'AUDIT_EVENT', ...entry }); return entry; }
  async generateComplianceReport() { const report = { generatedAt: new Date().toISOString(), localOnly: true, authorizationReference: this.authorizationReference, eventCount: this.auditLog.length, events: this.auditLog.map((entry) => ({ ...entry })), exclusions: ['No network discovery', 'No credential probing', 'No card writing or cloning', 'No relay simulation', 'No Wiegand payload capture'] }; report.integrityHash = await sha256(stableStringify(report)); return report; }
  sessionClear() { this.authorized = false; this.authorizationReference = null; this.auditLog = []; this.previousHash = 'GENESIS'; this.transientKey = null; }
}
