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
    this.pendingLlmAction = null;
    this.latestTelemetry = null;
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

  async handleStartNfcReader() {
    return this.withAudit(async () => {
      const result = await this.adapter.startNfcReaderSession((techSummary) => {
        const classification = this.nfcAuditor.classify(`${(techSummary.recordTypes || []).join(' ')} iso 14443-a`);
        this.setText('nfc-reader-status', `Live tag detected. ${classification.classification}: ${classification.finding}`);
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
      if (data) { this.renderTelemetry(data); this.firewall.generateAlert(data); }
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
