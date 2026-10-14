/**
 * DataFirewall - Local Packet Validation, Threat Assessment & Audit Engine
 *
 * Public contract kept stable for the existing tests (minimal packet validation,
 * 100-point trust score, runDataFirewall) and extended with the alert generator
 * and the SecurityAuditFirewall that js/app.js depends on.
 */

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

/**
 * Validates the minimum shape expected of a locally processed module packet.
 */
export function validateModulePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) {
    return false;
  }

  return Boolean(packet.id || packet.type || packet.payload);
}

/**
 * Strict module-packet schema (source module, quality flag, timestamp, value object).
 */
export function validateStrictModulePacket(packet) {
  return Boolean(packet && typeof packet === 'object' && MODULE_FIELDS[packet.source_module] && typeof packet.ok === 'boolean' && ['OK', 'DEGRADED', 'ERROR'].includes(packet.data_quality) && Number.isFinite(packet.timestamp) && packet.value && typeof packet.value === 'object');
}

export function computeFreshnessTrust(packet) {
  if (!validateStrictModulePacket(packet)) return 0;
  const age = Math.max(0, Date.now() - packet.timestamp);
  return Math.max(0, Math.min(1, (packet.data_quality === 'OK' ? 1 : 0.55) - Math.min(age / 120000, 0.8)));
}

export function deriveCardState(packets = []) {
  const valid = packets.filter(validateStrictModulePacket);
  if (!valid.length) return 'OFFLINE';
  if (valid.some((packet) => packet.source_module === 'thermal' && Number(packet.value.temperatureC) >= 80)) return 'LOST';
  return 'ONLINE';
}

export function isActionApproved(action) {
  return new Set(['RGB_MODE', 'BUZZER_TONE', 'GPIO_SET', 'MODULE_RESTART']).has(action);
}

export async function dispatchApprovedCommand(adapter, action, params = {}) {
  if (!isActionApproved(action)) throw new Error('Action is not approved.');
  const handlers = { RGB_MODE: () => adapter.setRgbMode(params.mode), BUZZER_TONE: () => adapter.sendBuzzerTone(params.frequency, params.duration), GPIO_SET: () => adapter.setGpioPin(params.pin, params.value), MODULE_RESTART: () => adapter.restartModule(params.moduleId) };
  return handlers[action]();
}

/**
 * Computes a bounded local trust score from available telemetry indicators.
 */
export function computeTrustScore(telemetry = {}) {
  const source = telemetry && typeof telemetry === 'object' ? telemetry : {};
  let score = 100;

  if (source.anomalyDetected) score -= 30;
  if (source.unauthorizedBle) score -= 20;
  if (source.pinTampered) score -= 25;

  return Math.max(0, score);
}

/**
 * Applies the local validation and trust policy without external dependencies.
 */
export function runDataFirewall(payload, rules = [], minTrustScore = 50) {
  const trustScore = computeTrustScore(payload);
  const isValid = validateModulePacket(payload);
  const activeRules = Array.isArray(rules) ? rules : [];

  const ruleResults = activeRules.map((rule) => {
    try {
      if (typeof rule === 'function') {
        return rule(payload, { trustScore, isValid }) !== false;
      }

      if (rule && typeof rule.evaluate === 'function') {
        return rule.evaluate(payload, { trustScore, isValid }) !== false;
      }

      return true;
    } catch {
      return false;
    }
  });

  const rulesPassed = ruleResults.every(Boolean);
  const threshold = Number.isFinite(minTrustScore) ? minTrustScore : 50;

  return {
    allowed: isValid && trustScore >= threshold && rulesPassed,
    trustScore,
    timestamp: Date.now()
  };
}

export class DataFirewall {
  constructor(config = {}) {
    this.rules = Array.isArray(config.rules) ? config.rules : [];
    this.minTrustScore = Number.isFinite(config.minTrustScore)
      ? config.minTrustScore
      : 50;
    this.alerts = [];
  }

  evaluate(packet) {
    return runDataFirewall(packet, this.rules, this.minTrustScore);
  }

  generateAlert(telemetry) {
    const alerts = [];
    if (telemetry.thermal > 40.0) alerts.push({ level: 'CRITICAL', type: 'THERMAL_EXCEEDED', value: telemetry.thermal });
    if (telemetry.nfc && telemetry.nfc.eventsLast5Min > 10) alerts.push({ level: 'HIGH', type: 'NFC_BURST', value: telemetry.nfc.eventsLast5Min });
    this.alerts.push(...alerts);
    return alerts;
  }
}

export class SecurityAuditFirewall extends DataFirewall {
  constructor({ vault = null, expectedPin = null } = {}) {
    super();
    this.vault = vault;
    this.expectedPin = expectedPin;
    this.authorized = false;
    this.authorizationReference = null;
    this.auditLog = [];
    this.previousHash = 'GENESIS';
    this.transientKey = null;
  }

  sanitizeMetadata(value) {
    const secretPattern = /(pin|pass(word|phrase)?|secret|token|credential|key|payload|uid|card.?data)/i;
    if (Array.isArray(value)) return value.map((item) => this.sanitizeMetadata(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretPattern.test(key) ? '[REDACTED]' : this.sanitizeMetadata(item)]));
    }
    if (typeof value === 'string' && value.length > 512) return '[TRUNCATED]';
    return value;
  }

  async verifyAuthorization(authTicket, adminPIN, acknowledged = false) {
    const ticket = String(authTicket || '').trim();
    const pin = String(adminPIN || '');
    const validTicket = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(ticket);
    const validPin = pin.length >= 6 && pin.length <= 256 && (!this.expectedPin || pin === this.expectedPin);
    if (!acknowledged || !validTicket || !validPin) return { authorized: false, reason: 'A valid local ticket, passphrase, and acknowledgment are required.' };
    this.authorized = true;
    this.authorizationReference = ticket;
    this.transientKey = await sha256(`${ticket}:${Date.now()}:${Math.random()}`);
    await this.logEvent('SESSION_START', { acknowledgment: true, authorizationTicket: ticket });
    return { authorized: true, reference: ticket };
  }

  async logEvent(action, data = {}) {
    if (!this.authorized && action !== 'SESSION_START') throw new Error('Audit session is locked. Verify authorization first.');
    const entry = {
      timestamp: new Date().toISOString(),
      action: String(action || 'UNSPECIFIED').replace(/[^A-Z0-9_:-]/gi, '_').slice(0, 96),
      authorizationReference: this.authorizationReference,
      metadata: this.sanitizeMetadata(data),
      previousHash: this.previousHash
    };
    entry.integrityHash = await sha256(stableStringify(entry));
    this.previousHash = entry.integrityHash;
    this.auditLog.push(entry);
    if (this.vault?.isUnlocked && typeof this.vault.store === 'function') await this.vault.store({ type: 'AUDIT_EVENT', ...entry });
    return entry;
  }

  async generateComplianceReport() {
    const report = {
      generatedAt: new Date().toISOString(),
      localOnly: true,
      authorizationReference: this.authorizationReference,
      eventCount: this.auditLog.length,
      controls: {
        iso27001: ['A.5.15 Access control', 'A.5.24 Information security incident management', 'A.7.5 Physical security monitoring', 'A.8.9 Configuration management'],
        nist80053: ['AC-3 Access Enforcement', 'AU-2 Event Logging', 'AU-9 Protection of Audit Information', 'PE-3 Physical Access Control', 'SI-4 System Monitoring']
      },
      events: this.auditLog.map((entry) => ({ ...entry })),
      exclusions: ['No network discovery', 'No credential probing', 'No card writing or cloning', 'No relay simulation', 'No Wiegand payload capture']
    };
    report.integrityHash = await sha256(stableStringify(report));
    return report;
  }

  sessionClear() {
    this.authorized = false;
    this.authorizationReference = null;
    this.auditLog = [];
    this.previousHash = 'GENESIS';
    this.transientKey = null;
  }
}
