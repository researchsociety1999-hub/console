import { JokerAdapter } from './joker-adapter.js';
import { DataFirewall, SecurityAuditFirewall } from './data-firewall.js';
import { NFCSecurityAuditor, TSCMThermalScanner, GPIOSecurityMonitor, OfflineAssetAuditor, NetworkRadarScanner } from './security-audit-suite.js';
import { LocalConsoleLLM } from './local-llm-controller.js';

export const THEME_PRESETS = {
  operator: { '--bg-primary': '#0a0800', '--bg-panel': 'rgba(20,14,0,0.86)', '--bg-panel-alt': 'rgba(14,10,0,0.72)', '--accent-cyber': '#ffb020', '--accent-cyber-dim': '#7a5410', '--accent-warning': '#ff8c1a', '--accent-critical': '#ff4757', '--text-main': '#ffe6c2', '--text-dim': '#8f7550', '--panel-border': '#3d2c1f' },
  tactical: { '--bg-primary': '#050805', '--bg-panel': 'rgba(10,16,8,0.86)', '--bg-panel-alt': 'rgba(8,12,6,0.72)', '--accent-cyber': '#8faa3c', '--accent-cyber-dim': '#556622', '--accent-warning': '#c0392b', '--accent-critical': '#ff4757', '--text-main': '#e3e8cf', '--text-dim': '#7a8560', '--panel-border': '#33401f' },
  clinical: { '--bg-primary': '#0a0a0a', '--bg-panel': 'rgba(20,20,20,0.9)', '--bg-panel-alt': 'rgba(30,30,30,0.8)', '--accent-cyber': '#ffffff', '--accent-cyber-dim': '#888888', '--accent-warning': '#ffd400', '--accent-critical': '#ff3b30', '--text-main': '#ffffff', '--text-dim': '#aaaaaa', '--panel-border': '#444444' }
};

export class AppController {
  constructor() {
    this.adapter = new JokerAdapter();
    this.firewall = new DataFirewall();
    this.vaultUnlocked = false;
    this.auditFirewall = new SecurityAuditFirewall({ vault: this.createLocalVaultBridge() });
    this.nfcAuditor = new NFCSecurityAuditor();
    this.thermalScanner = new TSCMThermalScanner();
    this.gpioMonitor = new GPIOSecurityMonitor({ dataFirewall: this.auditFirewall });
    this.assetAuditor = new OfflineAssetAuditor();
    this.radarScanner = new NetworkRadarScanner();
    this.localLLM = new LocalConsoleLLM({ appController: this, dataFirewall: this.auditFirewall });
    this.pollTimer = null;
    this.pendingLlmAction = null;
    this.latestTelemetry = null;
    this.currentTheme = 'operator';
  }

  createLocalVaultBridge() {
    return {
      get isUnlocked() { return false; },
      store: async () => undefined
    };
  }

  async init() {
    this.bindEvents();
    this.updateStatus('MANIFESTED / TRUSTED');
    this.setAuditLocked(true, 'Locked: authorization required.');
    window.addEventListener('pagehide', () => { this.clearAuditSession(); this.localLLM.unloadSession(); });
    window.addEventListener('beforeunload', () => { this.clearAuditSession(); this.localLLM.unloadSession(); });
  }

  bindEvents() {
    this.bind('connect-btn', 'click', () => this.handleConnect());
    this.bind('header-emergency-lock-btn', 'click', () => this.handleEmergencyLockdown());
    this.bind('emergency-btn', 'click', () => this.handleEmergencyLockdown());
    this.bind('scan-all-btn', 'click', () => this.handleScanAll());
    this.bind('lockdown-btn', 'click', () => this.handleLockdown());
    this.bind('command-export-btn', 'click', () => this.exportComplianceReport());
    this.bind('theme-select', 'change', (event) => this.handleThemeChange(event.target.value));
    this.bind('vault-unlock-btn', 'click', () => this.handleVaultUnlock());
    this.bind('verify-authorization-btn', 'click', () => this.verifyAuthorization());
    this.bind('classify-nfc-btn', 'click', () => this.classifyNfc());
    this.bind('start-nfc-reader-btn', 'click', () => this.handleStartNfcReader());
    this.bind('assess-assets-btn', 'click', () => this.assessAssets());
    this.bind('calibrate-thermal-btn', 'click', () => this.calibrateThermal());
    this.bind('scan-thermal-btn', 'click', () => this.scanThermal());
    this.bind('refresh-gpio-btn', 'click', () => this.refreshGpio());
    this.bind('toggle-door-btn', 'click', () => this.handleToggleGpioLine('doorContact'));
    this.bind('toggle-pir-btn', 'click', () => this.handleToggleGpioLine('pirMotion'));
    this.bind('toggle-tamper-btn', 'click', () => this.handleToggleGpioLine('vibrationTamper'));
    this.bind('run-self-test-btn', 'click', () => this.handleSelfTest('gpio'));
    this.bind('export-compliance-btn', 'click', () => this.exportComplianceReport());
    this.bind('clear-audit-session-btn', 'click', () => this.clearAuditSession());
    this.bind('gguf-file-input', 'change', (event) => this.handleGgufFileSelected(event));
    this.bind('llm-execute-btn', 'click', () => this.handleLlmExecute());
    this.bind('confirm-action-btn', 'click', () => this.handleConfirmLlmAction());
    this.bind('cancel-action-btn', 'click', () => this.handleCancelLlmAction());
  }

  bind(id, event, handler) {
    const element = document.getElementById(id);
    if (element) element.addEventListener(event, handler);
  }

  async handleConnect() {
    if (this.adapter.connected) {
      await this.adapter.disconnect();
      this.clearAuditSession();
      this.localLLM.unloadSession();
      this.updateStatus('DISCONNECTED');
    } else {
      await this.adapter.connect();
      this.updateStatus('CONNECTED');
      this.startPolling();
    }
  }

  handleThemeChange(themeName) {
    const preset = THEME_PRESETS[themeName] || THEME_PRESETS.operator;
    if (typeof document !== 'undefined') {
      Object.entries(preset).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    }
    this.currentTheme = themeName;
  }

  handleVaultUnlock(providedPassphrase) {
    const pass = providedPassphrase ?? document.getElementById('vault-passphrase')?.value;
    if (pass) {
      this.vaultUnlocked = true;
      const statusEl = document.getElementById('vault-status');
      if (statusEl) statusEl.textContent = 'Unlocked (local session)';
    }
  }

  async verifyAuthorization() {
    const ticket = document.getElementById('auth-reference')?.value;
    const pin = document.getElementById('admin-pin')?.value;
    const acknowledged = Boolean(document.getElementById('research-ack')?.checked);
    const result = await this.auditFirewall.verifyAuthorization(ticket, pin, acknowledged);
    this.setAuditLocked(!result.authorized, result.authorized ? `Authorized locally for ${result.reference}.` : result.reason);
    if (result.authorized) this.updateStatus('AUTHORIZED / LOCAL AUDIT ACTIVE');
  }

  setAuditLocked(locked, message) {
    ['nfc-center-panel', 'device-control-panel', 'fleet-status-panel'].forEach((id) => {
      const panel = document.getElementById(id);
      if (panel) { panel.classList.toggle('locked', locked); panel.setAttribute('aria-disabled', String(locked)); }
    });
    const status = document.getElementById('authorization-status');
    if (status) status.textContent = message;
  }

  async withAudit(action) {
    if (!this.auditFirewall.authorized) { this.setAuditLocked(true, 'Locked: verify local authorization first.'); return null; }
    try { return await action(); } catch (error) { this.updateStatus(`AUDIT ERROR: ${error.message}`); return null; }
  }

  updateNfcPostureMeter(risk) {
    const fill = document.getElementById('nfc-posture-meter-fill');
    if (!fill) return;
    const percent = { LOW: 20, REVIEW: 55, ELEVATED: 85, UNKNOWN: 50 }[risk] ?? 50;
    fill.style.width = `${percent}%`;
  }

  async classifyNfc() {
    return this.withAudit(async () => {
      const metadata = document.getElementById('nfc-technology')?.value || '';
      const result = this.nfcAuditor.classify(metadata);
      await this.auditFirewall.logEvent('NFC_CLASSIFICATION', { classification: result.classification, risk: result.risk, readOnly: true });
      this.setText('nfc-audit-result', `${result.classification}: ${result.finding}`);
      this.updateNfcPostureMeter(result.risk);
      this.updateStatus('NFC TECHNOLOGY REVIEW COMPLETE');
      return result;
    });
  }

  async handleStartNfcReader() {
    return this.withAudit(async () => {
      const result = await this.adapter.startNfcReaderSession((techSummary) => {
        const classification = this.nfcAuditor.classify(`${(techSummary.recordTypes || []).join(' ')} iso 14443-a`);
        this.setText('nfc-reader-status', `Live tag detected. ${classification.classification}: ${classification.finding}`);
        this.updateNfcPostureMeter(classification.risk);
        this.auditFirewall.logEvent('NFC_LIVE_READ', { recordTypes: techSummary.recordTypes, serialNumberPresent: techSummary.serialNumberPresent, classification: classification.classification }).catch(() => {});
      });
      if (!result.supported) this.setText('nfc-reader-status', 'Web NFC is unsupported in this browser; use manual classification instead.');
      else if (result.error) this.setText('nfc-reader-status', `Live NFC reader error: ${result.error}`);
      else this.setText('nfc-reader-status', 'Live NFC reader active (Web NFC).');
      return result;
    });
  }

  async assessAssets() {
    return this.withAudit(async () => {
      const raw = document.getElementById('asset-inventory')?.value || '[]';
      const result = this.assetAuditor.assess(JSON.parse(raw));
      await this.auditFirewall.logEvent('ASSET_ASSESSMENT', { assetCount: result.assetCount, reviewRequired: result.reviewRequired });
      this.setText('asset-audit-result', `Offline assessment complete: ${result.reviewRequired} of ${result.assetCount} assets require review.`);
      return result;
    });
  }

  async calibrateThermal() {
    return this.withAudit(async () => {
      this.adapter.calibrateThermalBaseline();
      const telemetry = await this.adapter.getSafeAuditTelemetry();
      if (!telemetry) throw new Error('Connect local hardware before calibration.');
      const baseline = this.thermalScanner.calibrate(telemetry.thermalGrid);
      await this.auditFirewall.logEvent('THERMAL_BASELINE', { baseline: Number(baseline.toFixed(2)), sampleCount: telemetry.thermalGrid.length });
      this.setText('thermal-audit-result', `Ambient baseline calibrated at ${baseline.toFixed(2)}°C.`);
      return baseline;
    });
  }

  async scanThermal() {
    return this.withAudit(async () => {
      const telemetry = await this.adapter.getSafeAuditTelemetry();
      if (!telemetry) throw new Error('Connect local hardware before scanning.');
      const threshold = Number(document.getElementById('thermal-threshold')?.value || 2.5);
      const result = this.thermalScanner.scan(telemetry.thermalGrid, threshold);
      this.thermalScanner.render(document.getElementById('thermal-display'), result);
      const labels = result.anomalies.map((anomaly) => this.thermalScanner.classifyAnomaly(anomaly.delta));
      await this.auditFirewall.logEvent('THERMAL_SCAN', { baseline: result.baseline, threshold: result.threshold, anomalyCount: result.anomalies.length });
      this.setText('thermal-audit-result', `${result.status}: ${result.anomalies.length} local heat anomalies found. ${labels.join('; ')}`.trim());
      this.updateStatus(result.status);
      return result;
    });
  }

  async refreshGpio() {
    return this.withAudit(async () => {
      const telemetry = await this.adapter.getSafeAuditTelemetry();
      if (!telemetry) throw new Error('Connect local hardware before reading states.');
      const result = await this.gpioMonitor.update(telemetry.gpio);
      await this.auditFirewall.logEvent('GPIO_STATUS', { doorContact: result.doorContact, pirMotion: result.pirMotion, vibrationTamper: result.vibrationTamper, activityOnly: result.activity });
      this.setText('gpio-monitor-status', `Door: ${result.doorContact ? 'closed' : 'open'} | PIR: ${result.pirMotion ? 'motion' : 'clear'} | Tamper: ${result.vibrationTamper ? 'alert' : 'clear'} | D0/D1 activity: ${result.activity.wiegandD0}/${result.activity.wiegandD1}`);
      return result;
    });
  }

  async handleToggleGpioLine(lineName) {
    return this.withAudit(async () => {
      const result = this.adapter.toggleGpioLine(lineName);
      await this.auditFirewall.logEvent('GPIO_LINE_TOGGLE', { line: lineName, active: result.active, activity: result.activity });
      await this.refreshGpio();
      return result;
    });
  }

  async handleSelfTest(moduleId) {
    return this.withAudit(async () => {
      const result = await this.adapter.triggerModuleSelfTest(moduleId);
      await this.auditFirewall.logEvent('MODULE_SELF_TEST', result);
      this.setText('gpio-monitor-status', `Self-test ${result.passed ? 'PASSED' : 'FAILED'} (${result.latencyMs}ms, run #${result.runCount}).`);
      return result;
    });
  }

  async handleScanAll() {
    return this.withAudit(async () => {
      await this.refreshGpio();
      await this.scanThermal();
      const radarCanvas = document.getElementById('radar-display');
      if (radarCanvas) this.radarScanner.render(radarCanvas, this.adapter.getRadarScanData());
      await this.auditFirewall.logEvent('SCAN_ALL', { triggeredAt: new Date().toISOString() });
      this.appendAlertStream('Full local scan cycle completed (thermal + GPIO + radar).', 'info');
      return true;
    });
  }

  handleLockdown() {
    this.setAuditLocked(true, 'Locked: manual lockdown engaged.');
    this.appendAlertStream('Manual lockdown engaged. Re-authorization required for gated modules.', 'warning');
  }

  async handleEmergencyLockdown() {
    if (this.adapter.connected) await this.adapter.disconnect();
    this.clearAuditSession();
    this.localLLM.unloadSession();
    this.appendAlertStream('EMERGENCY LOCKDOWN triggered. Hardware disconnected and session zeroized.', 'critical');
    this.updateStatus('EMERGENCY LOCKDOWN');
  }

  async exportComplianceReport() {
    return this.withAudit(async () => {
      const report = await this.auditFirewall.generateComplianceReport();
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `local-compliance-report-${Date.now()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      this.updateStatus('LOCAL COMPLIANCE REPORT EXPORTED');
      return report;
    });
  }

  clearAuditSession() {
    this.auditFirewall.sessionClear();
    this.setAuditLocked(true, 'Audit session cleared locally.');
    this.setText('nfc-audit-result', 'Awaiting authorized input.');
    this.setText('asset-audit-result', 'No inventory assessed.');
    this.setText('thermal-audit-result', 'Baseline not calibrated.');
    this.setText('gpio-monitor-status', 'No physical state sampled.');
  }

  async handleGgufFileSelected(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    this.setText('model-loading-status', `Loading ${file.name}…`);
    try {
      await this.localLLM.loadModelFromBlob(file, (progress) => {
        const percent = typeof progress === 'number' ? Math.round(progress * 100) : progress;
        this.setText('model-loading-status', `Loading ${file.name}: ${percent ?? ''}%`);
      });
      this.setText('model-loading-status', `Loaded: ${file.name}`);
      const panel = document.getElementById('llm-console-interface');
      if (panel) { panel.classList.remove('disabled-panel'); panel.setAttribute('aria-disabled', 'false'); }
    } catch (error) {
      this.setText('model-loading-status', `Model load failed: ${error.message}`);
    }
  }

  appendLlmLog(text, kind = 'info') {
    const log = document.getElementById('llm-output-log');
    if (!log) return;
    const line = document.createElement('div');
    line.textContent = text;
    line.className = `llm-log-${kind}`;
    log.appendChild(line);
  }

  appendAlertStream(text, severity = 'log') {
    const stream = document.getElementById('alert-stream');
    if (!stream) return;
    const line = document.createElement('div');
    line.className = `alert-${severity}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    stream.prepend(line);
    while (stream.childNodes.length > 50) stream.removeChild(stream.lastChild);
  }

  renderFleetStatus() {
    const list = document.getElementById('fleet-device-list');
    if (!list) return;
    const activity = Object.values(this.adapter.getGpioSnapshot()).reduce((sum, line) => sum + line.activity, 0);
    list.textContent = `LOCAL-NODE-01 | ${this.adapter.connected ? 'ONLINE' : 'OFFLINE'} | Transport: ${this.adapter.transport} | GPIO events: ${activity}`;
  }

  showLlmConfirmationModal(pending) {
    this.pendingLlmAction = pending;
    this.setText('confirmation-details', `Action: ${pending.action}\nParams: ${JSON.stringify(pending.params || {})}`);
    const modal = document.getElementById('llm-confirmation-modal');
    if (modal) { modal.classList.remove('hidden-modal'); modal.setAttribute('aria-hidden', 'false'); modal.style.display = 'block'; }
  }

  hideLlmConfirmationModal() {
    const modal = document.getElementById('llm-confirmation-modal');
    if (modal) { modal.classList.add('hidden-modal'); modal.setAttribute('aria-hidden', 'true'); modal.style.display = 'none'; }
    this.pendingLlmAction = null;
    const passInput = document.getElementById('confirmation-passphrase');
    if (passInput) passInput.value = '';
  }

  async handleConfirmLlmAction() {
    if (!this.pendingLlmAction) { this.hideLlmConfirmationModal(); return; }
    const pending = this.pendingLlmAction;
    const passphrase = document.getElementById('confirmation-passphrase')?.value || '';
    const params = { ...(pending.params || {}), humanConfirmed: true };
    if (pending.action === 'UNLOCK_VAULT_SESSION') params.passphrase = passphrase;
    const result = this.localLLM.dispatchCommand({ action: pending.action, params });
    await this.auditFirewall.logEvent('HUMAN_APPROVED', { action: pending.action, status: result.status }).catch(() => {});
    this.appendLlmLog(`[Approved] ${pending.action} -> ${result.status}`, 'success');
    this.hideLlmConfirmationModal();
  }

  async handleCancelLlmAction() {
    if (!this.pendingLlmAction) { this.hideLlmConfirmationModal(); return; }
    const pending = this.pendingLlmAction;
    await this.auditFirewall.logEvent('HUMAN_DENIED', { action: pending.action }).catch(() => {});
    this.appendLlmLog(`[Denied] ${pending.action} was blocked by the user.`, 'blocked');
    this.hideLlmConfirmationModal();
  }

  async handleLlmExecute() {
    const input = document.getElementById('llm-command-input')?.value?.trim();
    if (!input) return;
    this.appendLlmLog(`User: ${input}`, 'user');
    try {
      const context = { telemetry: this.latestTelemetry, gpio: this.adapter.getGpioSnapshot() };
      const result = await this.localLLM.executeUserCommand(input, context);
      this.appendLlmLog(`Model: ${result.response}`, 'model');
      if (result.executed) {
        if (result.executed.status === 'CONFIRMATION_REQUIRED') {
          this.showLlmConfirmationModal(result.executed);
        } else {
          this.appendLlmLog(`[Tool: ${result.executed.action || 'none'} -> ${result.executed.status}]`, 'success');
          await this.auditFirewall.logEvent('LLM_TOOL_RESULT', { action: result.executed.action, status: result.executed.status }).catch(() => {});
        }
      }
    } catch (error) {
      this.appendLlmLog(`Error: ${error.message}`, 'error');
    }
    const commandInput = document.getElementById('llm-command-input');
    if (commandInput) commandInput.value = '';
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (!this.adapter.connected) return;
      const data = await this.adapter.sample();
      if (data) {
        this.renderTelemetry(data);
        const alerts = this.firewall.generateAlert(data);
        alerts.forEach((alert) => this.appendAlertStream(`${alert.type}: ${JSON.stringify(alert.value)}`, alert.level === 'CRITICAL' ? 'critical' : alert.level === 'HIGH' ? 'warning' : 'info'));
      }
    }, 1000);
  }

  renderTelemetry(data) {
    const apply = () => {
      this.setText('temp-val', data.thermal.toFixed(1));
      this.setText('wifi-val', data.wifi.accessPoints);
      this.setText('ble-val', data.ble.devices);
      this.setText('nfc-val', data.nfc.eventsLast5Min);
      this.updateTelemetryBadge(data.thermal);
      this.latestTelemetry = data;
      const radarCanvas = document.getElementById('radar-display');
      if (radarCanvas) this.radarScanner.render(radarCanvas, this.adapter.getRadarScanData());
      this.renderFleetStatus();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    else apply();
  }

  updateTelemetryBadge(thermal) {
    const badge = document.getElementById('predicted-state-badge');
    if (!badge) return;
    badge.classList.remove('badge-ok', 'badge-warn', 'badge-critical');
    if (thermal >= 38) badge.classList.add('badge-critical');
    else if (thermal >= 32) badge.classList.add('badge-warn');
    else badge.classList.add('badge-ok');
  }

  setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
  updateStatus(status) { this.setText('predicted-state-badge', status); }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();
});
