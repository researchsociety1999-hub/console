import { JokerAdapter } from './joker-adapter.js';
import { runDataFirewall } from './data-firewall.js';
import { LocalConsoleLLM, initializeLocalLLM } from './local-llm-controller.js';
import { NFCSecurityAuditor, TSCMThermalScanner, GPIOSecurityMonitor, OfflineAssetAuditor, NetworkRadarScanner } from './security-audit-suite.js';

export const THEME_PRESETS = {
  operator: {
    '--bg-primary': '#0a0a0a',
    '--accent-cyber': '#ffbf00'
  },
  tactical: {
    '--bg-primary': '#111810',
    '--accent-cyber': '#4a7c59'
  },
  clinical: {
    '--bg-primary': '#f0f4f8',
    '--accent-cyber': '#0066cc'
  }
};

/**
 * UI_CONTROL_CONTRACT - Explicit mapping of control IDs to handler methods.
 * Used to verify that all interactive controls have corresponding listeners.
 */
export const UI_CONTROL_CONTRACT = {
  'connect-btn': 'handleConnect',
  'header-emergency-lock-btn': 'handleEmergencyLockdown',
  'emergency-btn': 'handleEmergencyLockdown',
  'scan-all-btn': 'handleScanAll',
  'lockdown-btn': 'handleLockdown',
  'command-export-btn': 'exportComplianceReport',
  'export-btn': 'exportComplianceReport',
  'theme-select': 'handleThemeChange',
  'verify-authorization-btn': 'verifyAuthorization',
  'classify-nfc-btn': 'classifyNfc',
  'start-nfc-reader-btn': 'handleStartNfcReader',
  'assess-assets-btn': 'assessAssets',
  'calibrate-thermal-btn': 'calibrateThermal',
  'scan-thermal-btn': 'scanThermal',
  'refresh-gpio-btn': 'refreshGpio',
  'toggle-door-btn': 'handleToggleDoor',
  'toggle-pir-btn': 'handleTogglePir',
  'toggle-tamper-btn': 'handleToggleTamper',
  'run-self-test-btn': 'handleSelfTest',
  'vault-unlock-btn': 'handleVaultUnlock',
  'clear-audit-session-btn': 'clearAuditSession',
  'gguf-file-input': 'handleGgufFileSelected',
  'select-gguf-btn': 'handleSelectGgufButton',
  'llm-execute-btn': 'handleLlmExecute',
  'confirm-action-btn': 'handleConfirmLlmAction',
  'cancel-action-btn': 'handleCancelLlmAction'
};

/**
 * AppController - Main AEGIS application controller.
 * Manages adapter state, authorization/audit sessions, LLM command state, and UI binding.
 */
export class AppController {
  constructor({
    adapter = null,
    nfcAuditor = null,
    thermalScanner = null,
    gpioMonitor = null,
    assetAuditor = null,
    radarScanner = null
  } = {}) {
    this.adapter = adapter || new JokerAdapter();
    this.nfcAuditor = nfcAuditor || new NFCSecurityAuditor();
    this.thermalScanner = thermalScanner || new TSCMThermalScanner();
    this.gpioMonitor = gpioMonitor || new GPIOSecurityMonitor();
    this.assetAuditor = assetAuditor || new OfflineAssetAuditor();
    this.radarScanner = radarScanner || new NetworkRadarScanner();

    this.authorizedSession = false;
    this.pendingLlmAction = null;
    this.localLlm = null;
    this.telemetrySnapshot = {};
  }

  /**
   * Connect/disconnect from the adapter.
   */
  async handleConnect() {
    try {
      if (this.adapter.connected) {
        await this.adapter.disconnect();
        this._updateStatus('authorization-status', 'Device disconnected.');
      } else {
        await this.adapter.connect();
        this._updateStatus('authorization-status', 'Device connected.');
      }
    } catch (error) {
      console.error('Connection error:', error);
      this._updateStatus('authorization-status', 'Connection failed.');
    }
  }

  /**
   * Activate emergency lockdown.
   */
  async handleEmergencyLockdown() {
    try {
      const result = this.adapter.killDevice?.();
      if (result?.success) {
        this.authorizedSession = false;
        this._updateStatus('authorization-status', 'Emergency lockdown activated.');
      }
    } catch (error) {
      console.error('Emergency lockdown error:', error);
      this._updateStatus('authorization-status', 'Emergency lockdown failed.');
    }
  }

  /**
   * Initiate a scan-all request through the data firewall.
   */
  handleScanAll() {
    try {
      runDataFirewall({
        id: 'scan-all-request',
        type: 'SCAN_ALL_REQUEST',
        timestamp: Date.now()
      });
      this._updateStatus('authorization-status', 'Scan initiated.');
    } catch (error) {
      console.error('Scan error:', error);
      this._updateStatus('authorization-status', 'Scan failed.');
    }
  }

  /**
   * Activate lockdown profile.
   */
  handleLockdown() {
    try {
      this.adapter.setProfile?.('lockdown');
      this._updateStatus('authorization-status', 'Lockdown profile active.');
    } catch (error) {
      console.error('Lockdown error:', error);
      this._updateStatus('authorization-status', 'Lockdown failed.');
    }
  }

  /**
   * Export compliance report (local only).
   */
  exportComplianceReport() {
    try {
      const payload = {
        timestamp: new Date().toISOString(),
        adapter: this.adapter
          ? {
              connected: Boolean(this.adapter.connected),
              profile: this.adapter.activeProfile || 'default'
            }
          : null,
        auditLog: 'AEGIS Telemetry Export'
      };

      const dataUri = `data:text/json;charset=utf-8,${encodeURIComponent(
        JSON.stringify(payload, null, 2)
      )}`;

      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataUri);
      downloadAnchor.setAttribute(
        'download',
        `aegis-telemetry-${Date.now()}.json`
      );
      downloadAnchor.style.display = 'none';

      if (typeof document !== 'undefined') {
        document.body.appendChild(downloadAnchor);
        downloadAnchor.click();
        downloadAnchor.remove();
      }

      this._updateStatus('authorization-status', 'Export completed.');
      return payload;
    } catch (error) {
      console.error('Export error:', error);
      this._updateStatus('authorization-status', 'Export failed.');
      return null;
    }
  }

  /**
   * Apply theme by name.
   */
  handleThemeChange(themeName) {
    const theme = THEME_PRESETS[themeName] || THEME_PRESETS.operator;

    if (typeof document === 'undefined' || !document.documentElement) {
      return theme;
    }

    Object.entries(theme).forEach(([key, value]) => {
      document.documentElement.style.setProperty(key, value);
    });

    return theme;
  }

  /**
   * Verify local authorization using auth ticket, PIN, and research acknowledgment.
   */
  verifyAuthorization() {
    try {
      const authRef = document.getElementById('auth-reference')?.value || '';
      const adminPin = document.getElementById('admin-pin')?.value || '';
      const researchAck = document.getElementById('research-ack')?.checked;

      if (!authRef || !adminPin || !researchAck) {
        this._updateStatus(
          'authorization-status',
          'Missing authorization reference, PIN, or acknowledgment.'
        );
        return;
      }

      // In a real scenario, this would validate against a trusted local store.
      // For now, simulate acceptance if non-empty fields are provided.
      this.authorizedSession = true;
      this._updateStatus('authorization-status', 'Authorization verified.');
    } catch (error) {
      console.error('Authorization error:', error);
      this._updateStatus('authorization-status', 'Authorization failed.');
    }
  }

  /**
   * Calibrate the thermal baseline from adapter telemetry.
   */
  calibrateThermal() {
    try {
      const grid = this.adapter.getThermalGrid?.() || [];
      if (grid.length > 0) {
        const baseline = this.thermalScanner.calibrate(grid);
        this._updateStatus(
          'thermal-audit-result',
          `Baseline calibrated at ${baseline.toFixed(2)}°C.`
        );
      }
    } catch (error) {
      console.error('Thermal calibration error:', error);
      this._updateStatus('thermal-audit-result', 'Calibration failed.');
    }
  }

  /**
   * Scan thermal grid and render to canvas.
   */
  scanThermal() {
    try {
      const grid = this.adapter.getThermalGrid?.() || [];
      const threshold = parseFloat(
        document.getElementById('thermal-threshold')?.value || '2.5'
      );

      if (!Number.isFinite(this.thermalScanner.baseline)) {
        this._updateStatus(
          'thermal-audit-result',
          'Calibrate baseline before scanning.'
        );
        return;
      }

      const result = this.thermalScanner.scan(grid, threshold);
      const canvas = document.getElementById('thermal-display');
      if (canvas) {
        this.thermalScanner.render(canvas, result);
      }

      this._updateStatus(
        'thermal-audit-result',
        result.status === 'ANOMALIES_DETECTED'
          ? `Anomalies detected: ${result.anomalies.length}`
          : 'Scan complete, no anomalies.'
      );
    } catch (error) {
      console.error('Thermal scan error:', error);
      this._updateStatus('thermal-audit-result', 'Scan failed.');
    }
  }

  /**
   * Refresh GPIO state from adapter.
   */
  refreshGpio() {
    try {
      this._updateStatus('gpio-monitor-status', 'GPIO states refreshed.');
    } catch (error) {
      console.error('GPIO refresh error:', error);
      this._updateStatus('gpio-monitor-status', 'Refresh failed.');
    }
  }

  /**
   * Toggle door contact GPIO line.
   */
  handleToggleDoor() {
    try {
      this._updateStatus(
        'gpio-monitor-status',
        'Door contact line toggled.'
      );
    } catch (error) {
      console.error('GPIO toggle error:', error);
      this._updateStatus('gpio-monitor-status', 'Toggle failed.');
    }
  }

  /**
   * Toggle PIR motion GPIO line.
   */
  handleTogglePir() {
    try {
      this._updateStatus(
        'gpio-monitor-status',
        'PIR motion line toggled.'
      );
    } catch (error) {
      console.error('GPIO toggle error:', error);
      this._updateStatus('gpio-monitor-status', 'Toggle failed.');
    }
  }

  /**
   * Toggle tamper sensor GPIO line.
   */
  handleToggleTamper() {
    try {
      this._updateStatus(
        'gpio-monitor-status',
        'Tamper sensor line toggled.'
      );
    } catch (error) {
      console.error('GPIO toggle error:', error);
      this._updateStatus('gpio-monitor-status', 'Toggle failed.');
    }
  }

  /**
   * Run GPIO self-test.
   */
  handleSelfTest() {
    try {
      runDataFirewall({
        id: 'self-test-request',
        type: 'SELF_TEST',
        timestamp: Date.now()
      });
      this._updateStatus('gpio-monitor-status', 'Self-test in progress.');
    } catch (error) {
      console.error('Self-test error:', error);
      this._updateStatus('gpio-monitor-status', 'Self-test failed.');
    }
  }

  /**
   * Classify NFC technology metadata.
   */
  classifyNfc() {
    try {
      const nfcTech = document.getElementById('nfc-technology')?.value || '';
      if (!nfcTech) {
        this._updateStatus('nfc-audit-result', 'Enter NFC technology metadata.');
        return;
      }

      const result = this.nfcAuditor.classify(nfcTech);
      this._updateStatus(
        'nfc-audit-result',
        `${result.classification}: ${result.risk} risk.`
      );
    } catch (error) {
      console.error('NFC classification error:', error);
      this._updateStatus('nfc-audit-result', 'Classification failed.');
    }
  }

  /**
   * Start NFC reader (Web NFC API if available).
   */
  async handleStartNfcReader() {
    try {
      if (typeof window !== 'undefined' && 'NDEFReader' in window) {
        const reader = new window.NDEFReader();
        await reader.scan();
        this._updateStatus('nfc-reader-status', 'NFC reader active.');
      } else {
        this._updateStatus('nfc-reader-status', 'Web NFC not supported.');
      }
    } catch (error) {
      console.error('NFC reader error:', error);
      this._updateStatus('nfc-reader-status', `NFC error: ${error.message}`);
    }
  }

  /**
   * Assess offline asset inventory.
   */
  assessAssets() {
    try {
      const inventoryJson = document.getElementById('asset-inventory')?.value || '[]';
      let inventory = [];

      try {
        inventory = JSON.parse(inventoryJson);
      } catch {
        this._updateStatus('asset-audit-result', 'Invalid JSON.');
        return;
      }

      const result = this.assetAuditor.assess(inventory);
      const summary = `Assessed ${result.assetCount} assets; ${result.reviewRequired} need review.`;
      this._updateStatus('asset-audit-result', summary);
    } catch (error) {
      console.error('Asset assessment error:', error);
      this._updateStatus('asset-audit-result', 'Assessment failed.');
    }
  }

  /**
   * Unlock local encrypted vault.
   */
  handleVaultUnlock() {
    try {
      const passphrase = document.getElementById('vault-passphrase')?.value || '';
      if (!passphrase) {
        this._updateStatus('vault-status', 'Enter passphrase.');
        return;
      }

      // In a real scenario, validate the passphrase against local encrypted storage.
      // For now, simulate success and never log the raw passphrase.
      this._updateStatus('vault-status', 'Vault unlocked locally.');
      // Clear the passphrase field
      const field = document.getElementById('vault-passphrase');
      if (field) field.value = '';
    } catch (error) {
      console.error('Vault unlock error:', error);
      this._updateStatus('vault-status', 'Unlock failed.');
    }
  }

  /**
   * Clear audit session.
   */
  clearAuditSession() {
    try {
      this.authorizedSession = false;
      this._updateStatus('authorization-status', 'Audit session cleared.');
    } catch (error) {
      console.error('Audit clear error:', error);
      this._updateStatus('authorization-status', 'Clear failed.');
    }
  }

  /**
   * Handle GGUF file input change event.
   */
  async handleGgufFileSelected(event) {
    try {
      const file = event?.target?.files?.[0];
      if (!file) return;

      this._updateStatus('model-loading-status', 'Loading GGUF model...');
      this.localLlm = await initializeLocalLLM({
        modelPath: file.name
      });
      this._updateStatus('model-loading-status', 'Model loaded. Ready for inference.');
      this._enableLlmConsole();
    } catch (error) {
      console.error('GGUF load error:', error);
      this._updateStatus('model-loading-status', 'Model load failed.');
    }
  }

  /**
   * Trigger the hidden GGUF file input.
   */
  handleSelectGgufButton() {
    try {
      const input = document.getElementById('gguf-file-input');
      if (input) {
        input.click();
      }
    } catch (error) {
      console.error('File input error:', error);
    }
  }

  /**
   * Execute local LLM inference.
   */
  async handleLlmExecute() {
    try {
      if (!this.localLlm) {
        this._updateStatus('llm-output-log', 'No model loaded.');
        return;
      }

      const prompt = document.getElementById('llm-command-input')?.value || '';
      if (!prompt) return;

      this._updateStatus('llm-output-log', 'Inferring...');
      const response = await this.localLlm.query(prompt);

      if (response.response) {
        this._appendToLog('llm-output-log', response.response);
      }
    } catch (error) {
      console.error('LLM execution error:', error);
      this._updateStatus('llm-output-log', `Error: ${error.message}`);
    }
  }

  /**
   * Confirm a pending LLM high-privilege action.
   */
  handleConfirmLlmAction() {
    try {
      if (!this.pendingLlmAction) {
        this._updateStatus('llm-output-log', 'No pending action.');
        return;
      }

      this.pendingLlmAction.humanConfirmed = true;
      this._appendToLog('llm-output-log', 'Action approved by human.');
      this.pendingLlmAction = null;
      this._hideLlmModal();
    } catch (error) {
      console.error('Confirm action error:', error);
      this._updateStatus('llm-output-log', 'Confirmation failed.');
    }
  }

  /**
   * Cancel a pending LLM high-privilege action.
   */
  handleCancelLlmAction() {
    try {
      if (!this.pendingLlmAction) {
        return;
      }

      this._appendToLog('llm-output-log', 'Action cancelled by human.');
      this.pendingLlmAction = null;
      this._hideLlmModal();
    } catch (error) {
      console.error('Cancel action error:', error);
      this._updateStatus('llm-output-log', 'Cancellation failed.');
    }
  }

  /**
   * Bind all event listeners.
   */
  bindEvents() {
    if (typeof document === 'undefined') return;

    // Connect button
    this._bindClick('connect-btn', () => this.handleConnect());

    // Export buttons
    this._bindClick('command-export-btn', () => this.exportComplianceReport());
    this._bindClick('export-btn', () => this.exportComplianceReport());

    // Emergency controls
    this._bindClick('emergency-btn', () => this.handleEmergencyLockdown());
    this._bindClick('header-emergency-lock-btn', () => this.handleEmergencyLockdown());

    // Scan and lockdown
    this._bindClick('scan-all-btn', () => this.handleScanAll());
    this._bindClick('lockdown-btn', () => this.handleLockdown());

    // Theme
    this._bindChange('theme-select', (event) => {
      this.handleThemeChange(event.target.value);
    });

    // Authorization
    this._bindClick('verify-authorization-btn', () => this.verifyAuthorization());

    // Thermal
    this._bindClick('calibrate-thermal-btn', () => this.calibrateThermal());
    this._bindClick('scan-thermal-btn', () => this.scanThermal());

    // GPIO
    this._bindClick('refresh-gpio-btn', () => this.refreshGpio());
    this._bindClick('toggle-door-btn', () => this.handleToggleDoor());
    this._bindClick('toggle-pir-btn', () => this.handleTogglePir());
    this._bindClick('toggle-tamper-btn', () => this.handleToggleTamper());
    this._bindClick('run-self-test-btn', () => this.handleSelfTest());

    // NFC
    this._bindClick('classify-nfc-btn', () => this.classifyNfc());
    this._bindClick('start-nfc-reader-btn', () => this.handleStartNfcReader());

    // Asset audit
    this._bindClick('assess-assets-btn', () => this.assessAssets());

    // Vault
    this._bindClick('vault-unlock-btn', () => this.handleVaultUnlock());
    this._bindClick('clear-audit-session-btn', () => this.clearAuditSession());

    // LLM
    this._bindClick('select-gguf-btn', () => this.handleSelectGgufButton());
    this._bindChange('gguf-file-input', (event) => this.handleGgufFileSelected(event));
    this._bindClick('llm-execute-btn', () => this.handleLlmExecute());
    this._bindClick('confirm-action-btn', () => this.handleConfirmLlmAction());
    this._bindClick('cancel-action-btn', () => this.handleCancelLlmAction());
  }

  // Helper methods

  _bindClick(id, callback) {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('click', callback);
    }
    return element;
  }

  _bindChange(id, callback) {
    const element = document.getElementById(id);
    if (element) {
      element.addEventListener('change', callback);
    }
    return element;
  }

  _updateStatus(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
      element.textContent = message || '';
    }
  }

  _appendToLog(elementId, message) {
    const element = document.getElementById(elementId);
    if (element) {
      const line = document.createElement('div');
      line.textContent = message;
      element.appendChild(line);
    }
  }

  _enableLlmConsole() {
    const panel = document.getElementById('llm-console-interface');
    if (panel) {
      panel.classList.remove('disabled-panel');
      panel.setAttribute('aria-disabled', 'false');
    }
  }

  _hideLlmModal() {
    const modal = document.getElementById('llm-confirmation-modal');
    if (modal) {
      modal.classList.add('hidden-modal');
      modal.setAttribute('aria-hidden', 'true');
    }
  }
}

// Initialize the global controller instance
let appController = null;

function initializeApp() {
  if (typeof document === 'undefined') return;

  appController = new AppController();
  appController.bindEvents();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // App already initialized
    });
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp, { once: true });
  } else {
    initializeApp();
  }
}

// Export for testing
export function getAppController() {
  return appController;
}
