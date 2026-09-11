import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { ConsoleStateMachine, STATES } from '../js/state-machine.js';
import { validateModulePacket, sanitizeValue, computeTrustScore, deriveCardState, dispatchApprovedCommand, isActionApproved, runDataFirewall } from '../js/data-firewall.js';
import { Watchdog } from '../js/watchdog.js';
import { formatWllamaLoadError } from '../js/local-model.js';
import { JokerAdapter } from '../js/joker-adapter.js';
import { renderModuleDetailHtml } from '../js/module-detail.js';

const validPacket = {
  source_module: 'wifi',
  ok: true,
  data_quality: 'OK',
  timestamp: Date.now(),
  value: { accessPoints: 12, frameRate: 30 }
};

describe('data firewall', () => {
  it('accepts valid telemetry packets and sanitizes schema fields', () => {
    expect(validateModulePacket(validPacket)).toBe(true);
    expect(sanitizeValue('wifi', { accessPoints: 12, frameRate: 30, bad: 'value' })).toEqual({ accessPoints: 12, frameRate: 30 });
  });

  it('calculates lower trust for stale or low-quality data', () => {
    const stalePacket = { ...validPacket, timestamp: Date.now() - 60000, data_quality: 'DEGRADED', value: { accessPoints: 0, frameRate: 0 } };
    expect(computeTrustScore(validPacket)).toBeGreaterThan(computeTrustScore(stalePacket));
  });

  it('derives offline and critical states from validated packets', () => {
    expect(deriveCardState([validPacket])).toBe('ONLINE');
    expect(deriveCardState([{ ...validPacket, source_module: 'thermal', value: { temperatureC: 90 }, trust: 1 }])).toBe('LOST');
  });

  it('approves only trusted actions and rejects unsafe ones', () => {
    expect(isActionApproved('RGB_MODE')).toBe(true);
    expect(isActionApproved('DANGEROUS_ACTION')).toBe(false);
    const adapter = {
      setRgbMode: async (mode) => ({ mode, status: 'ok' }),
      sendBuzzerTone: async () => ({ status: 'ok' }),
      setGpioPin: async () => ({ status: 'ok' })
    };

    return dispatchApprovedCommand(adapter, 'RGB_MODE', { mode: 'alert-sweep' }).then((res) => {
      expect(res.mode).toBe('alert-sweep');
    });
  });
});

describe('state machine', () => {
  it('starts in ghost mode and requires an explicit wake action to manifest', () => {
    const sm = new ConsoleStateMachine();
    expect(sm.state).toBe(STATES.GHOST);
    sm.manifest();
    expect(sm.state).toBe(STATES.MANIFESTED);
    sm.enterGhost();
    expect(sm.state).toBe(STATES.GHOST);
    sm.manifest();
    expect(sm.state).toBe(STATES.MANIFESTED);
  });
});

describe('watchdog', () => {
  it('fires a BLE novelty alert and escalates thermal thresholds when sustained', () => {
    const alerts = [];
    const watchdog = new Watchdog({
      intervalMs: 100,
      isActive: () => true,
      getThermalSample: () => 90,
      getModuleSamples: () => [{ source_module: 'ble', ok: true, data_quality: 'OK', value: { newDeviceId: 'ble-42' } }],
      onAlert: (alert) => alerts.push(alert)
    });

    watchdog._thermalHistory = [90, 90, 90];
    watchdog.start();
    watchdog._tick();
    expect(alerts.some((a) => a.type === 'NEW_BLE_DEVICE')).toBe(true);
    expect(alerts.some((a) => a.type === 'THERMAL_CRITICAL')).toBe(true);
    watchdog.stop();
  });
});

describe('connection profile and firewall gating', () => {
  it('accepts a valid custom PCB connection profile and keeps the transport settings usable', () => {
    const adapter = new JokerAdapter();
    const profile = {
      transport: 'wifi',
      boardType: 'Custom PCB',
      deviceName: 'PCB-ALPHA',
      endpointUrl: 'https://console.local/board',
      wifiSsid: 'JokerNet',
      wifiPassword: 'secret'
    };

    adapter.setProfile(profile);
    const validation = adapter.validateConnectionProfile();
    expect(validation.valid).toBe(true);
    expect(adapter.connectionProfile.transport).toBe('wifi');
    expect(adapter.connectionProfile.deviceName).toBe('PCB-ALPHA');
  });

  it('blocks telemetry when the console is not connected to a trusted device profile', () => {
    const result = runDataFirewall(validPacket, { connected: false, transport: 'wifi', boardType: 'Custom PCB' });
    expect(result.context.reason).toBe('DEVICE_NOT_CONNECTED');
    expect(result.alert.type).toBe('DEVICE_NOT_CONNECTED');
  });

  it('connects in simulation and disconnects cleanly', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    expect(adapter.connected).toBe(true);
    expect(adapter.sample()).toBeTruthy();
    adapter.disconnect();
    expect(adapter.connected).toBe(false);
    expect(adapter.sample()).toBeNull();
  });

  it('rejects incomplete physical connection profiles before connecting', async () => {
    const adapter = new JokerAdapter();
    adapter.setProfile({ transport: 'wifi', endpointUrl: '', wifiSsid: '' });
    expect(adapter.validateConnectionProfile().valid).toBe(false);
    await expect(adapter.connect()).rejects.toThrow(/endpoint URL|Wi-Fi SSID/i);
  });

  it('routes safe module commands and enforces stealth output suppression', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    expect((await adapter.setGpioPin(1, 'HIGH')).action).toBe('GPIO_SET');
    expect((await adapter.setRgbMode('alert-sweep')).action).toBe('RGB_MODE');
    await adapter.setStealthMode(true);
    expect((await adapter.setRgbMode('alert-sweep')).status).toBe('suppressed_by_stealth_mode');
    expect((await adapter.sendBuzzerTone()).status).toBe('suppressed_by_stealth_mode');
    expect((await adapter.restartModule('ble')).action).toBe('MODULE_RESTART');
  });

  it('requires confirmation and then executes the hardware kill switch', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    expect((await adapter.killDevice()).requiresConfirmation).toBe(true);
    const result = await adapter.killDevice({ confirmed: true });
    expect(result.success).toBe(true);
    expect(adapter.isDevicePoweredOff()).toBe(true);
    expect(adapter.connected).toBe(false);
  });
});

describe('HUD wiring and generated module controls', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  it('contains the primary HUD controls and loads the app controller', () => {
    for (const id of ['connect', 'ghost', 'diagnostic', 'stateBtn', 'stealthToggle', 'killDeviceToggle', 'applyConnectionProfile', 'exportIntel', 'clearVault', 'unlockVault']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('<script type="module" src="./js/app.js"></script>');
  });

  it('renders controls for every interactive hardware module', () => {
    const state = { nfcEvents: 0, aps: 0, ble: 0 };
    expect(renderModuleDetailHtml('nfc', state)).toContain('data-action="restart-module"');
    expect(renderModuleDetailHtml('wifi', state)).toContain('data-module="wifi"');
    expect(renderModuleDetailHtml('ble', state)).toContain('data-module="ble"');
    expect(renderModuleDetailHtml('badusb', state)).toContain('data-action="hack"');
    expect(renderModuleDetailHtml('gpio', state)).toContain('data-action="gpio"');
    expect(renderModuleDetailHtml('rgb', state)).toContain('data-action="rgb"');
    expect(renderModuleDetailHtml('buzzer', state)).toContain('data-action="buzzer-test"');
    expect(renderModuleDetailHtml('console', state)).toContain('data-action="scroll"');
  });
});

describe('local model error handling', () => {
  it('turns CDN fetch failures into a clear user-facing message', () => {
    const message = formatWllamaLoadError(new Error('Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/@wllama/wllama@latest/dist/index.mjs'));
    expect(message).toMatch(/blocked|Local Model|cdn/i);
  });
});
