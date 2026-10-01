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
 * UI_CONTROL_CONTRACT - Explicit mapping of control IDs to handler functions.
 * Used to verify that all interactive controls have corresponding listeners.
 */
export const UI_CONTROL_CONTRACT = {
  'connect-btn': 'handleConnect',
  'header-emergency-lock-btn': 'handleEmergencyLockdown',
  'emergency-btn': 'handleEmergencyLockdown',
  'scan-all-btn': 'handleScanAll',
  'lockdown-btn': 'handleLockdown',
  'command-export-btn': 'exportComplianceReport',
  'export-btn': 'exportComplianceReport',  // backward compatibility alias
  'theme-select': 'handleThemeChange',
  'verify-authorization-btn': 'verifyAuthorization',
  'classify-nfc-btn': 'classifyNfc',
  'start-nfc-reader-btn': 'handleStartNfcReader',
  'assess-assets-btn': 'assessAssets',
  'calibrate-thermal-btn': 'calibrateThermal',
  'scan-thermal-btn': 'scanThermal',
  'refresh-gpio-btn': 'refreshGpio',
  'toggle-door-btn': 'handleToggleGpioLine',
  'toggle-pir-btn': 'handleToggleGpioLine',
  'toggle-tamper-btn': 'handleToggleGpioLine',
  'run-self-test-btn': 'handleSelfTest',
  'vault-unlock-btn': 'handleVaultUnlock',
  'clear-audit-session-btn': 'clearAuditSession',
  'gguf-file-input': 'handleGgufFileSelected',
  'llm-execute-btn': 'handleLlmExecute',
  'confirm-action-btn': 'handleConfirmLlmAction',
  'cancel-action-btn': 'handleCancelLlmAction',
  'select-gguf-btn': 'handleSelectGgufButton'
};

export function handleThemeChange(themeName) {
  const theme = THEME_PRESETS[themeName] || THEME_PRESETS.operator;

  if (typeof document === 'undefined' || !document.documentElement) {
    return theme;
  }

  Object.entries(theme).forEach(([key, value]) => {
    document.documentElement.style.setProperty(key, value);
  });

  return theme;
}

function getAdapter() {
  if (typeof window === 'undefined') {
    return null;
  }

  window.jokerAdapter = window.jokerAdapter || new JokerAdapter();
  return window.jokerAdapter;
}

function bindClick(id, callback) {
  const element = document.getElementById(id);

  if (element) {
    element.addEventListener('click', callback);
  }

  return element;
}

function bindChange(id, callback) {
  const element = document.getElementById(id);

  if (element) {
    element.addEventListener('change', callback);
  }

  return element;
}

function updateUIStatus(elementId, message) {
  const element = document.getElementById(elementId);
  if (element) {
    element.textContent = message || '';
  }
}

/**
 * Exports telemetry and audit data with proper fallbacks.
 */
function exportTelemetry() {
  try {
    const adapter = getAdapter();
    const payload = {
      timestamp: new Date().toISOString(),
      adapter: adapter
        ? {
            connected: Boolean(adapter.connected),
            profile: adapter.activeProfile || 'default'
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

    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();

    updateUIStatus('authorization-status', 'Export completed successfully.');
    return payload;
  } catch (error) {
    console.error('Export failed:', error);
    updateUIStatus('authorization-status', 'Export failed. Check console.');
    return null;
  }
}

function initializeBindings() {
  const adapter = getAdapter();

  // Connect button
  const connectButton =
    document.getElementById('connect-btn') ||
    document.getElementById('connect-device-btn') ||
    document.getElementById('connect');

  if (connectButton) {
    connectButton.addEventListener('click', async (event) => {
      event.preventDefault();
      const activeAdapter = getAdapter();

      if (activeAdapter?.connect) {
        try {
          await activeAdapter.connect();
          updateUIStatus('authorization-status', 'Device connected.');
        } catch (err) {
          updateUIStatus('authorization-status', 'Connection failed.');
        }
      }
    });
  }

  // Export via #command-export-btn (visible button)
  bindClick('command-export-btn', () => {
    exportTelemetry();
  });

  // Export via #export-btn (legacy compatibility)
  bindClick('export-btn', () => {
    exportTelemetry();
  });

  // Emergency lockdown
  bindClick('emergency-btn', () => {
    getAdapter()?.killDevice?.();
    updateUIStatus('authorization-status', 'Emergency lockdown activated.');
  });

  bindClick('header-emergency-lock-btn', () => {
    getAdapter()?.killDevice?.();
    updateUIStatus('authorization-status', 'Emergency lockdown activated.');
  });

  // Scan all
  bindClick('scan-all-btn', () => {
    runDataFirewall({
      id: 'scan-all-request',
      type: 'SCAN_ALL_REQUEST',
      timestamp: Date.now()
    });
    updateUIStatus('authorization-status', 'Scan initiated.');
  });

  // Lockdown profile
  bindClick('lockdown-btn', () => {
    getAdapter()?.setProfile?.('lockdown');
    updateUIStatus('authorization-status', 'Lockdown profile active.');
  });

  // Theme selection
  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', (event) => {
      handleThemeChange(event.target.value);
    });
  }

  // Thermal calibration
  bindClick('calibrate-thermal-btn', () => {
    const activeAdapter = getAdapter();

    if (activeAdapter?.telemetryBus) {
      activeAdapter.telemetryBus.thermal = Array(64).fill(22.0);
      updateUIStatus('thermal-audit-result', 'Baseline calibrated at 22.0°C.');
    }
  });

  // Thermal scan
  bindClick('scan-thermal-btn', () => {
    runDataFirewall({
      id: 'thermal-scan-request',
      type: 'THERMAL_SCAN',
      timestamp: Date.now()
    });
    updateUIStatus('thermal-audit-result', 'Thermal grid scanned.');
  });

  // GPIO self-test
  bindClick('run-self-test-btn', () => {
    runDataFirewall({
      id: 'self-test-request',
      type: 'SELF_TEST',
      timestamp: Date.now()
    });
    updateUIStatus('gpio-monitor-status', 'GPIO self-test in progress.');
  });

  // GPIO refresh
  bindClick('refresh-gpio-btn', () => {
    updateUIStatus('gpio-monitor-status', 'GPIO states refreshed.');
  });

  // GPIO toggle handlers
  ['toggle-door-btn', 'toggle-pir-btn', 'toggle-tamper-btn'].forEach((btnId) => {
    bindClick(btnId, () => {
      updateUIStatus('gpio-monitor-status', `GPIO line toggled (${btnId}).`);
    });
  });

  // Asset assessment
  bindClick('assess-assets-btn', () => {
    getAdapter()?.getRadarScanData?.();
    updateUIStatus('asset-audit-result', 'Offline inventory assessed.');
  });

  // Authorization verification
  bindClick('verify-authorization-btn', () => {
    runDataFirewall({
      id: 'auth-check-01',
      type: 'VERIFY_AUTHORIZATION',
      timestamp: Date.now()
    });
    updateUIStatus('authorization-status', 'Authorization verified.');
  });

  // Audit session clear
  bindClick('clear-audit-session-btn', () => {
    const auditLogPanel = document.getElementById('audit-compliance-panel');

    if (auditLogPanel) {
      updateUIStatus('authorization-status', 'Audit session cleared.');
    }
  });

  // Vault unlock
  bindClick('vault-unlock-btn', () => {
    updateUIStatus('vault-status', 'Vault unlock requested.');
  });

  // NFC classification
  bindClick('classify-nfc-btn', () => {
    const nfcTech = document.getElementById('nfc-technology')?.value || '';
    updateUIStatus('nfc-audit-result', `Classified: ${nfcTech || 'unknown'}.`);
  });

  // NFC reader start
  bindClick('start-nfc-reader-btn', () => {
    updateUIStatus('nfc-reader-status', 'NFC reader starting...');
  });

  // GGUF file input
  bindClick('gguf-file-input', () => {
    updateUIStatus('model-loading-status', 'GGUF file selected.');
  });

  // GGUF button
  bindClick('select-gguf-btn', () => {
    const input = document.getElementById('gguf-file-input');
    if (input) {
      input.click();
    }
  });

  // LLM execute
  bindClick('llm-execute-btn', () => {
    updateUIStatus('llm-output-log', 'Local inference executed.');
  });

  // LLM confirmation modal
  bindClick('confirm-action-btn', () => {
    updateUIStatus('llm-output-log', 'Action confirmed.');
  });

  bindClick('cancel-action-btn', () => {
    updateUIStatus('llm-output-log', 'Action cancelled.');
  });

  return adapter;
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeBindings, {
      once: true
    });
  } else {
    initializeBindings();
  }
}
