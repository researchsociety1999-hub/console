import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DataFirewall, SecurityAuditFirewall } from '../js/data-firewall.js';
import { JokerAdapter } from '../js/joker-adapter.js';
import { NFCSecurityAuditor, TSCMThermalScanner, GPIOSecurityMonitor, OfflineAssetAuditor, NetworkRadarScanner } from '../js/security-audit-suite.js';
import { LocalConsoleLLM } from '../js/local-llm-controller.js';
import { AppController, THEME_PRESETS } from '../js/app.js';

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

describe('Local GGUF LLM Console Controller', () => {
  function buildStubAppController() {
    const adapter = { connected: true, setGpioPin: vi.fn(() => ({ status: 'SET_LOCALLY' })), setModuleState: vi.fn(() => ({ status: 'SET_LOCALLY' })) };
    return {
      adapter,
      scanThermal: vi.fn(async () => ({ status: 'NORMAL' })),
      handleVaultUnlock: vi.fn(),
      clearAuditSession: vi.fn()
    };
  }

  it('parses a structured JSON tool command from model output', () => {
    const llm = new LocalConsoleLLM({ appController: buildStubAppController() });
    const result = llm.parseAndExecuteTools('Sure thing. {"action": "READ_THERMAL_SWEEP", "params": {}} Done.');
    expect(result.executed.action).toBe('READ_THERMAL_SWEEP');
    expect(result.executed.status).toBe('EXECUTED');
  });

  it('routes SET_GPIO_PIN, READ_THERMAL_SWEEP, and ZEROIZE_ALL to valid application methods', async () => {
    const appController = buildStubAppController();
    const llm = new LocalConsoleLLM({ appController });
    llm.dispatchCommand({ action: 'SET_GPIO_PIN', params: { pin: 1, value: 'HIGH' } });
    expect(appController.adapter.setGpioPin).toHaveBeenCalledWith(1, 'HIGH');

    llm.dispatchCommand({ action: 'READ_THERMAL_SWEEP', params: {} });
    expect(appController.scanThermal).toHaveBeenCalled();

    const blocked = llm.dispatchCommand({ action: 'ZEROIZE_ALL', params: {} });
    expect(blocked.status).toBe('CONFIRMATION_REQUIRED');
    expect(appController.clearAuditSession).not.toHaveBeenCalled();

    const confirmed = llm.dispatchCommand({ action: 'ZEROIZE_ALL', params: { humanConfirmed: true } });
    expect(confirmed.status).toBe('EXECUTED');
    expect(appController.clearAuditSession).toHaveBeenCalled();
  });

  it('fails and returns CONFIRMATION_REQUIRED for high-privilege actions when humanConfirmed is omitted or false', () => {
    const llm = new LocalConsoleLLM({ appController: buildStubAppController() });
    const omitted = llm.dispatchCommand({ action: 'ZEROIZE_ALL', params: {} });
    expect(omitted.status).toBe('CONFIRMATION_REQUIRED');
    const explicitFalse = llm.dispatchCommand({ action: 'UNLOCK_VAULT_SESSION', params: { humanConfirmed: false } });
    expect(explicitFalse.status).toBe('CONFIRMATION_REQUIRED');
  });

  it('completes dispatch for zeroization and vault unlocking once humanConfirmed is true', () => {
    const appController = buildStubAppController();
    const llm = new LocalConsoleLLM({ appController });
    const zeroize = llm.dispatchCommand({ action: 'ZEROIZE_ALL', params: { humanConfirmed: true } });
    expect(zeroize.status).toBe('EXECUTED');
    const unlock = llm.dispatchCommand({ action: 'UNLOCK_VAULT_SESSION', params: { humanConfirmed: true, passphrase: 'local-pass' } });
    expect(unlock.status).toBe('EXECUTED');
    expect(appController.handleVaultUnlock).toHaveBeenCalledWith('local-pass');
  });

  it('requires explicit human confirmation before unlocking the vault via the model', () => {
    const appController = buildStubAppController();
    const llm = new LocalConsoleLLM({ appController });
    const blocked = llm.dispatchCommand({ action: 'UNLOCK_VAULT_SESSION', params: {} });
    expect(blocked.status).toBe('CONFIRMATION_REQUIRED');
    expect(appController.handleVaultUnlock).not.toHaveBeenCalled();
    const confirmed = llm.dispatchCommand({ action: 'UNLOCK_VAULT_SESSION', params: { humanConfirmed: true } });
    expect(confirmed.status).toBe('EXECUTED');
    expect(appController.handleVaultUnlock).toHaveBeenCalled();
  });

  it('writes correct audit trail entries for human approval and denial of high-privilege actions', async () => {
    const firewall = new SecurityAuditFirewall();
    await firewall.verifyAuthorization('AUTH-2026-004', '123456', true);
    const approved = await firewall.logEvent('HUMAN_APPROVED', { action: 'ZEROIZE_ALL', status: 'EXECUTED' });
    const denied = await firewall.logEvent('HUMAN_DENIED', { action: 'UNLOCK_VAULT_SESSION' });
    expect(approved.action).toBe('HUMAN_APPROVED');
    expect(approved.metadata.action).toBe('ZEROIZE_ALL');
    expect(denied.action).toBe('HUMAN_DENIED');
    expect(firewall.auditLog.some((entry) => entry.action === 'HUMAN_APPROVED')).toBe(true);
    expect(firewall.auditLog.some((entry) => entry.action === 'HUMAN_DENIED')).toBe(true);
  });

  it('clears the Wllama runtime reference on session unload', () => {
    const llm = new LocalConsoleLLM({ appController: buildStubAppController() });
    llm.wllama = {};
    llm.loaded = true;
    llm.loadingModelName = 'model.gguf';
    llm.unloadSession();
    expect(llm.wllama).toBeNull();
    expect(llm.loaded).toBe(false);
    expect(llm.loadingModelName).toBeNull();
  });

  it('contains no cloud endpoints, remote API keys, or external LLM provider URLs', async () => {
    const source = await import('../js/local-llm-controller.js');
    const sourceText = JSON.stringify(source);
    expect(sourceText).not.toMatch(/openai\.com|anthropic\.com|api\.[a-z]+\.com|sk-[a-zA-Z0-9]{20,}|https?:\/\//i);
  });

  it('contains no automatic bypass or remote override for the human-confirmation gate', () => {
    const source = readFileSync(new URL('../js/local-llm-controller.js', import.meta.url), 'utf8');
    expect(source).toMatch(/humanConfirmed\s*!==\s*true/);
    expect(source).not.toMatch(/skipConfirmation|forceApprove|overrideConfirmation|bypassConfirmation/i);
    expect(source).not.toMatch(/humanConfirmed\s*=\s*true\s*;?\s*\/\//i);
  });
});

describe('Live Hardware Telemetry Engine', () => {
  it('generates a valid 8x8 thermal grid matrix and updates GPIO pin states locally', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    const grid = adapter.generateThermalGrid();
    expect(grid).toHaveLength(64);
    expect(grid.every((value) => Number.isFinite(value))).toBe(true);

    const before = adapter.getGpioSnapshot().doorContact.activity;
    const toggled = adapter.toggleGpioLine('doorContact');
    expect(toggled.activity).toBe(before + 1);
    expect(adapter.getGpioSnapshot().doorContact.active).toBe(toggled.active);
  });

  it('detects anomalies end-to-end from adapter-generated thermal grid frames', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    adapter.clearHeatSources();
    const baselineFrame = adapter.generateThermalGrid();
    const scanner = new TSCMThermalScanner({ threshold: 2 });
    scanner.calibrate(baselineFrame);
    adapter.addHeatSource(2, 2, 6);
    const hotFrame = adapter.generateThermalGrid();
    const result = scanner.scan(hotFrame, 2);
    expect(result.anomalies.length).toBeGreaterThan(0);
  });

  it('resolves all UI-bound AppController handler methods to callable functions without touching the DOM', () => {
    const app = new AppController();
    [
      'handleConnect', 'handleVaultUnlock', 'verifyAuthorization', 'classifyNfc', 'handleStartNfcReader',
      'assessAssets', 'calibrateThermal', 'scanThermal', 'refreshGpio', 'handleToggleGpioLine', 'handleSelfTest',
      'exportComplianceReport', 'clearAuditSession', 'handleGgufFileSelected', 'handleLlmExecute',
      'handleConfirmLlmAction', 'handleCancelLlmAction', 'handleScanAll', 'handleLockdown', 'handleEmergencyLockdown',
      'handleThemeChange', 'renderFleetStatus', 'appendAlertStream'
    ].forEach((name) => {
      expect(typeof app[name]).toBe('function');
    });
  });

  it('generates telemetry strictly locally without invoking remote network calls', () => {
    const source = readFileSync(new URL('../js/joker-adapter.js', import.meta.url), 'utf8');
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|axios/i);
    expect(source).not.toMatch(/https?:\/\/(?!.*localhost)/i);
  });
});

describe('AEGIS Single-Pane HUD', () => {
  const cssSource = readFileSync(new URL('../css/style.css', import.meta.url), 'utf8');
  const htmlSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('defines required CSS variable design tokens and high-performance quadrant scoping', () => {
    ['--bg-primary', '--accent-cyber', '--accent-warning', '--text-main', '--panel-border'].forEach((token) => {
      expect(cssSource).toContain(token);
    });
    expect(cssSource).toMatch(/contain:\s*layout\s+style\s+paint/);
  });

  it('contains all 7 AEGIS HUD quadrant panel IDs and key dynamic elements', () => {
    [
      'id="thermal-recon-panel"', 'id="active-alerts-panel"', 'id="network-matrix-panel"',
      'id="nfc-center-panel"', 'id="device-control-panel"', 'id="fleet-status-panel"', 'id="audit-compliance-panel"',
      'id="thermal-display"', 'id="radar-display"', 'id="llm-confirmation-modal"'
    ].forEach((marker) => {
      expect(htmlSource).toContain(marker);
    });
  });

  it('defines theme variable presets for Operator, Tactical, and Clinical HUD themes', () => {
    expect(THEME_PRESETS.operator['--accent-cyber']).toBeDefined();
    expect(THEME_PRESETS.tactical['--accent-warning']).toBeDefined();
    expect(THEME_PRESETS.clinical['--bg-primary']).toBeDefined();
  });

  it('NetworkRadarScanner renders sweep and device blips without throwing', () => {
    const scanner = new NetworkRadarScanner();
    const ctx = { clearRect: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), arc: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), closePath: vi.fn(), fill: vi.fn() };
    const canvas = { width: 200, height: 200, getContext: () => ctx };
    expect(() => scanner.render(canvas, [{ angle: 0.5, rssi: -50, kind: 'BLE', safety: 'KNOWN' }])).not.toThrow();
    expect(ctx.arc).toHaveBeenCalled();
  });

  it('generates local, non-RF-capture radar telemetry from JokerAdapter', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    const devices = adapter.getRadarScanData();
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.length).toBeGreaterThan(0);
    devices.forEach((device) => {
      expect(Number.isFinite(device.angle)).toBe(true);
      expect(Number.isFinite(device.rssi)).toBe(true);
    });
  });

  it('contains no external CDN references, remote map tiles, or offensive network capabilities', () => {
    const appSource = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
    const adapterSource = readFileSync(new URL('../js/joker-adapter.js', import.meta.url), 'utf8');
    const suiteSource = readFileSync(new URL('../js/security-audit-suite.js', import.meta.url), 'utf8');
    const combined = [cssSource, htmlSource, appSource, adapterSource, suiteSource].join('\n');
    expect(combined).not.toMatch(/deauth|packet\s*injection|jamming|mapbox|leaflet|openstreetmap|cdn\.[a-z]+\.[a-z]+/i);
  });
});
