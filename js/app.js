import { JokerAdapter } from './joker-adapter.js';
import { DataFirewall, SecurityAuditFirewall } from './data-firewall.js';
import { LocalModelRuntime } from './local-model.js';
import { NFCSecurityAuditor, TSCMThermalScanner, GPIOSecurityMonitor, OfflineAssetAuditor } from './security-audit-suite.js';
import { LocalConsoleLLM } from './local-llm-controller.js';

export class AppController {
  constructor() {
    this.adapter = new JokerAdapter();
    this.firewall = new DataFirewall();
    this.localModel = new LocalModelRuntime();
    this.vaultUnlocked = false;
    this.auditFirewall = new SecurityAuditFirewall({ vault: this.createLocalVaultBridge() });
    this.nfcAuditor = new NFCSecurityAuditor();
    this.thermalScanner = new TSCMThermalScanner();
    this.gpioMonitor = new GPIOSecurityMonitor({ dataFirewall: this.auditFirewall });
    this.assetAuditor = new OfflineAssetAuditor();
    this.localLLM = new LocalConsoleLLM({ appController: this, dataFirewall: this.auditFirewall });
    this.pollTimer = null;
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
    this.bind('vault-unlock-btn', 'click', () => this.handleVaultUnlock());
    this.bind('verify-authorization-btn', 'click', () => this.verifyAuthorization());
    this.bind('classify-nfc-btn', 'click', () => this.classifyNfc());
    this.bind('assess-assets-btn', 'click', () => this.assessAssets());
    this.bind('calibrate-thermal-btn', 'click', () => this.calibrateThermal());
    this.bind('scan-thermal-btn', 'click', () => this.scanThermal());
    this.bind('refresh-gpio-btn', 'click', () => this.refreshGpio());
    this.bind('export-compliance-btn', 'click', () => this.exportComplianceReport());
    this.bind('clear-audit-session-btn', 'click', () => this.clearAuditSession());
    this.bind('gguf-file-input', 'change', (event) => this.handleGgufFileSelected(event));
    this.bind('llm-execute-btn', 'click', () => this.handleLlmExecute());
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

  handleVaultUnlock() {
    const pass = document.getElementById('vault-passphrase')?.value;
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
    const panel = document.getElementById('audit-modules');
    if (panel) { panel.classList.toggle('locked', locked); panel.setAttribute('aria-disabled', String(locked)); }
    const status = document.getElementById('authorization-status');
    if (status) status.textContent = message;
  }

  async withAudit(action) {
    if (!this.auditFirewall.authorized) { this.setAuditLocked(true, 'Locked: verify local authorization first.'); return null; }
    try { return await action(); } catch (error) { this.updateStatus(`AUDIT ERROR: ${error.message}`); return null; }
  }

  async classifyNfc() {
    return this.withAudit(async () => {
      const metadata = document.getElementById('nfc-technology')?.value || '';
      const result = this.nfcAuditor.classify(metadata);
      await this.auditFirewall.logEvent('NFC_CLASSIFICATION', { classification: result.classification, risk: result.risk, readOnly: true });
      this.setText('nfc-audit-result', `${result.classification}: ${result.finding}`);
      this.updateStatus('NFC TECHNOLOGY REVIEW COMPLETE');
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
      await this.auditFirewall.logEvent('THERMAL_SCAN', { baseline: result.baseline, threshold: result.threshold, anomalyCount: result.anomalies.length });
      this.setText('thermal-audit-result', `${result.status}: ${result.anomalies.length} local heat anomalies found.`);
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

  async handleLlmExecute() {
    const input = document.getElementById('llm-command-input')?.value?.trim();
    if (!input) return;
    const log = document.getElementById('llm-output-log');
    const appendLine = (text) => { if (log) { const line = document.createElement('div'); line.textContent = text; log.appendChild(line); } };
    appendLine(`User: ${input}`);
    try {
      const result = await this.localLLM.executeUserCommand(input);
      appendLine(`Model: ${result.response}`);
      if (result.executed) {
        appendLine(`[Tool: ${result.executed.action || 'none'} -> ${result.executed.status}]`);
        await this.auditFirewall.logEvent('LLM_TOOL_RESULT', { action: result.executed.action, status: result.executed.status }).catch(() => {});
      }
    } catch (error) {
      appendLine(`Error: ${error.message}`);
    }
    const commandInput = document.getElementById('llm-command-input');
    if (commandInput) commandInput.value = '';
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (!this.adapter.connected) return;
      const data = await this.adapter.sample();
      if (data) { this.renderTelemetry(data); this.firewall.generateAlert(data); }
    }, 2000);
  }

  renderTelemetry(data) {
    this.setText('temp-val', data.thermal.toFixed(1));
    this.setText('wifi-val', data.wifi.accessPoints);
    this.setText('ble-val', data.ble.devices);
    this.setText('nfc-val', data.nfc.eventsLast5Min);
  }

  setText(id, value) { const element = document.getElementById(id); if (element) element.textContent = value; }
  updateStatus(status) { this.setText('predicted-state-badge', status); }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new AppController();
  app.init();
});
