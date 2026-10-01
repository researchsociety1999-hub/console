import { JokerAdapter } from './joker-adapter.js';
import { runDataFirewall } from './data-firewall.js';

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

function exportTelemetry() {
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

  return payload;
}

function initializeBindings() {
  const adapter = getAdapter();

  const connectButton =
    document.getElementById('connect-btn') ||
    document.getElementById('connect-device-btn') ||
    document.getElementById('connect');

  if (connectButton) {
    connectButton.addEventListener('click', async (event) => {
      event.preventDefault();
      const activeAdapter = getAdapter();

      if (activeAdapter?.connect) {
        await activeAdapter.connect();
      }
    });
  }

  bindClick('emergency-btn', () => {
    getAdapter()?.killDevice?.();
  });

  bindClick('scan-all-btn', () => {
    runDataFirewall({
      id: 'scan-all-request',
      type: 'SCAN_ALL_REQUEST',
      timestamp: Date.now()
    });
  });

  bindClick('lockdown-btn', () => {
    getAdapter()?.setProfile?.('lockdown');
  });

  bindClick('export-btn', () => {
    exportTelemetry();
  });

  const themeSelect = document.getElementById('theme-select');
  if (themeSelect) {
    themeSelect.addEventListener('change', (event) => {
      handleThemeChange(event.target.value);
    });
  }

  bindClick('calibrate-thermal-btn', () => {
    const activeAdapter = getAdapter();

    if (activeAdapter?.telemetryBus) {
      activeAdapter.telemetryBus.thermal = Array(64).fill(22.0);
    }
  });

  bindClick('run-self-test-btn', () => {
    runDataFirewall({
      id: 'self-test-request',
      type: 'SELF_TEST',
      timestamp: Date.now()
    });
  });

  bindClick('assess-assets-btn', () => {
    getAdapter()?.getRadarScanData?.();
  });

  bindClick('verify-authorization-btn', () => {
    runDataFirewall({
      id: 'auth-check-01',
      type: 'VERIFY_AUTHORIZATION',
      timestamp: Date.now()
    });
  });

  bindClick('clear-audit-session-btn', () => {
    const auditLogPanel = document.getElementById('audit-compliance-panel');

    if (auditLogPanel) {
      auditLogPanel.innerText = 'Audit session cleared.';
    }
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
