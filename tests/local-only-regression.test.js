import { describe, it, expect } from 'vitest';
import { DataFirewall, SecurityAuditFirewall } from '../js/data-firewall.js';
import { JokerAdapter } from '../js/joker-adapter.js';
import { NFCSecurityAuditor, TSCMThermalScanner, GPIOSecurityMonitor, OfflineAssetAuditor } from '../js/security-audit-suite.js';

describe('Local-Only Core Architecture', () => {
  it('DataFirewall evaluates alerts locally without external requests', () => {
    const firewall = new DataFirewall();
    const alerts = firewall.generateAlert({ thermal: 42.5, nfc: { eventsLast5Min: 12 } });
    expect(alerts).toHaveLength(2);
    expect(alerts[0].type).toBe('THERMAL_EXCEEDED');
  });

  it('JokerAdapter connects and samples local telemetry', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    const sample = await adapter.sample();
    expect(sample).not.toBeNull();
    expect(sample.thermal).toBeGreaterThan(0);
  });
});

describe('Defensive Audit and Compliance', () => {
  it('enforces dual-factor local authorization and lock state', async () => {
    const firewall = new SecurityAuditFirewall();
    await expect(firewall.logEvent('NFC_CLASSIFICATION', {})).rejects.toThrow(/locked/i);
    expect((await firewall.verifyAuthorization('AUTH-2026-001', '123456', false)).authorized).toBe(false);
    expect((await firewall.verifyAuthorization('AUTH-2026-001', '123456', true)).authorized).toBe(true);
    expect(firewall.authorized).toBe(true);
    expect(firewall.auditLog[0].action).toBe('SESSION_START');
  });

  it('creates ISO timestamps, redacts secrets, and chains integrity hashes', async () => {
    const firewall = new SecurityAuditFirewall();
    await firewall.verifyAuthorization('AUTH-2026-002', '123456', true);
    const first = await firewall.logEvent('THERMAL_SCAN', { secret: 'do-not-log', adminPIN: '123456', anomalyCount: 1 });
    const second = await firewall.logEvent('GPIO_STATUS', { doorContact: true });
    expect(new Date(first.timestamp).toISOString()).toBe(first.timestamp);
    expect(first.metadata.secret).toBe('[REDACTED]');
    expect(first.metadata.adminPIN).toBe('[REDACTED]');
    expect(first.integrityHash).toMatch(/^(?:[a-f0-9]{64}|local-fallback-[a-f0-9]{8})$/);
    expect(second.previousHash).toBe(first.integrityHash);
    expect(second.integrityHash).not.toBe(first.integrityHash);
  });

  it('classifies NFC metadata in read-only defensive mode', () => {
    const auditor = new NFCSecurityAuditor();
    expect(auditor.classify('MIFARE Classic 1K').classification).toBe('LEGACY');
    expect(auditor.classify('DESFire EV3').classification).toBe('MODERN');
    expect(auditor.classify('DESFire EV3').readOnly).toBe(true);
  });

  it('calibrates thermal baseline and flags anomalies above the configured threshold', () => {
    const scanner = new TSCMThermalScanner({ threshold: 2.5 });
    expect(scanner.calibrate([20, 20, 20, 20])).toBe(20);
    const result = scanner.scan([20, 21, 22.6, 23], 2.5);
    expect(result.status).toBe('ANOMALIES_DETECTED');
    expect(result.anomalies).toHaveLength(1);
    expect(result.anomalies[0].value).toBe(23);
  });

  it('logs safe tamper states without capturing Wiegand payloads', async () => {
    const firewall = new SecurityAuditFirewall();
    await firewall.verifyAuthorization('AUTH-2026-003', '123456', true);
    const monitor = new GPIOSecurityMonitor({ dataFirewall: firewall });
    const result = await monitor.update({ doorContact: false, pirMotion: false, vibrationTamper: true, wiegandD0Activity: 2, wiegandD1Activity: 1, wiegandPayload: 'never captured' });
    expect(result.payloadCaptured).toBe(false);
    expect(result.activity.wiegandD0).toBe(2);
    expect(firewall.auditLog.some((entry) => entry.action === 'TAMPER_ALERT')).toBe(true);
  });

  it('assesses only user-provided asset inventory offline', () => {
    const auditor = new OfflineAssetAuditor();
    const result = auditor.assess([{ name: 'Camera-01', credentialRotationNeeded: true }, { name: 'AP-02', firmwareReviewNeeded: false }]);
    expect(result.assessedOffline).toBe(true);
    expect(result.reviewRequired).toBe(1);
  });

  it('contains no cloud endpoints, cloud SDKs, or prohibited active scanning modules', async () => {
    const sources = await Promise.all([
      import('../js/data-firewall.js'),
      import('../js/joker-adapter.js'),
      import('../js/security-audit-suite.js')
    ]);
    const sourceText = JSON.stringify(sources);
    expect(sourceText).not.toMatch(/supabase|onvif|rtsp|fetch\(|websocket.*wss?:\/\//i);
    const adapter = new JokerAdapter();
    expect(() => adapter.serializeSafeAuditEvent('CAMERA_DISCOVERY', {})).toThrow(/Unsupported/);
  });
});
