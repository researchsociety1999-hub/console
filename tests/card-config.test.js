import { describe, expect, it } from 'vitest';
import { CARD_PROTOCOL } from '../js/transports/card-protocol.js';
import { CARD_MAPPING, parseUptime } from '../js/transports/card-mapping.js';
import { CardWifiTransport } from '../js/transports/card-wifi-transport.js';
import { CardTelemetrySource } from '../js/sentinel/CardTelemetrySource.js';
import { SentinelConsole } from '../js/sentinel/SentinelConsole.js';

// Captured from the real card's /api/status on 2026-10-27. The name, MAC and Wi-Fi name were removed before sharing.
const STATUS = {
  name: 'removed', version: '1.0', board: 'SGP Card Joker / ESP32-S3-MINI-1-N8', uptime: '00:01:19',
  heap: 104720, minHeap: 90724, flash: 8388608, chip: 'ESP32-S3', rev: 2, cores: 2, cpu: 240, sdk: 'v5.5.4',
  mac: 'removed', apSSID: 'removed', apIP: '192.168.4.1', clients: 1, channel: 6, rssi: 0, usb: 'ready',
  pinActive: false, pinCur: 0, pinTo: 0, jiggle: false, vbat: -1, batPct: -1, batWarn: false,
  nfc: { present: true, fw: '1.6' }
};

const parsePacket = (body) => CARD_PROTOCOL.telemetry.parse(JSON.stringify(body));
const makeFetch = (getBody) => async () => {
  const body = getBody();
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

describe('card identity and parsing (real captured response)', () => {
  it('accepts the real response as the Joker card and keeps the board name', () => {
    expect(CARD_PROTOCOL.identity.parse(STATUS)).toEqual({ id: 'removed', name: STATUS.board });
  });

  it('rejects other devices and responses without a hardware id', () => {
    expect(CARD_PROTOCOL.identity.parse({ ...STATUS, board: 'Some Other Board' })).toBeNull();
    expect(CARD_PROTOCOL.identity.parse({ ...STATUS, mac: undefined })).toBeNull();
    expect(CARD_PROTOCOL.identity.parse(null)).toBeNull();
  });

  it('parses and validates the status and keeps the MAC out of the packet', () => {
    const packet = CARD_PROTOCOL.telemetry.validate(parsePacket(STATUS));
    expect(packet).toMatchObject({ heap: 104720, minHeap: 90724, clients: 1, channel: 6, uptime: '00:01:19', batPct: -1, nfcPresent: true, nfcFw: '1.6' });
    expect('mac' in packet).toBe(false);
    expect('name' in packet).toBe(false);
  });

  it('ignores other devices and rejects incomplete or out-of-range status data', () => {
    expect(parsePacket({ board: 'Other' })).toBeNull();
    expect(() => CARD_PROTOCOL.telemetry.validate(parsePacket({ ...STATUS, heap: undefined }))).toThrow(/Missing field "heap"/);
    expect(() => CARD_PROTOCOL.telemetry.validate(parsePacket({ ...STATUS, channel: 99 }))).toThrow(/out of range/);
    expect(() => CARD_PROTOCOL.telemetry.validate(parsePacket({ ...STATUS, heap: '104720' }))).toThrow(/Missing field "heap"/);
  });

  it('uses the card address and the status path, and no radar scan', () => {
    expect(CARD_PROTOCOL.baseUrl).toBe('http://192.168.4.1');
    expect(CARD_PROTOCOL.telemetry.path).toBe('/api/status');
    expect(JSON.stringify(Object.keys(CARD_PROTOCOL))).not.toMatch(/radar/);
    expect(CARD_PROTOCOL.allowCommands).toBeUndefined();
  });
});

describe('mapping to Sentinel samples', () => {
  const map = (body) => CARD_MAPPING.mapPacket(CARD_PROTOCOL.telemetry.validate(parsePacket(body)));

  it('maps the real response and leaves out battery when it is not measured', () => {
    const sample = map(STATUS);
    expect(sample.heapKb).toBeCloseTo(102.27, 1);
    expect(sample.minHeapKb).toBeCloseTo(88.6, 1);
    expect(sample).toMatchObject({ clients: 1, channel: 6, uptimeSeconds: 79, nfcReaderPresent: true, nfcFirmware: '1.6' });
    expect('batteryPct' in sample).toBe(false);
  });

  it('never creates the nfc, ble or temperature fields Sentinel would read as events', () => {
    const sample = map(STATUS);
    expect('nfc' in sample).toBe(false);
    expect('ble' in sample).toBe(false);
    expect('temperatureC' in sample).toBe(false);
  });

  it('maps a battery value only when it is 0 or more', () => {
    expect(map({ ...STATUS, batPct: 85 }).batteryPct).toBe(85);
    expect(map({ ...STATUS, batPct: 0 }).batteryPct).toBe(0);
  });

  it('converts uptime text to seconds and rejects other forms', () => {
    expect(parseUptime('00:01:19')).toBe(79);
    expect(parseUptime('100:00:00')).toBe(360000);
    expect(parseUptime('soon')).toBeUndefined();
    expect(parseUptime('00:61:00')).toBeUndefined();
    expect('uptimeSeconds' in map({ ...STATUS, uptime: 'soon' })).toBe(false);
  });

  it('exports the settings the live page reads', () => {
    expect(CARD_MAPPING.primaryMetric.key).toBe('heapKb');
    expect(CARD_MAPPING.requiredFields).toEqual(['heapKb', 'minHeapKb', 'uptimeSeconds']);
    expect(CARD_MAPPING.createCommandBridge).toBeUndefined();
  });
});

describe('end to end with the real configuration (fake network)', () => {
  const build = (getBody) => {
    let clock = 1000000;
    const transport = new CardWifiTransport({ descriptor: CARD_PROTOCOL, fetchImpl: makeFetch(getBody), pageProtocol: 'http:', now: () => clock });
    const telemetry = new CardTelemetrySource({ transport, mapPacket: CARD_MAPPING.mapPacket, requiredFields: CARD_MAPPING.requiredFields, now: () => clock });
    const app = new SentinelConsole({ telemetry, now: () => clock, storage: null, autoAct: false, metrics: CARD_MAPPING.metrics, resolveAfterCycles: CARD_MAPPING.resolveAfterCycles });
    return { transport, app, tick: () => { clock += 10000; return app.runMonitoringCycle(); } };
  };

  it('connects, shows the real memory reading and raises no alert for a healthy card', async () => {
    const { transport, app, tick } = build(() => STATUS);
    const identity = await transport.connect();
    expect(identity.deviceName).toBe(STATUS.board);
    const alerts = [];
    app.bus.on('alert:accepted', (a) => alerts.push(a));
    await tick();
    expect(app.store.get().cardState).toBe('manifested');
    expect(app.store.get().lastSample.heapKb).toBeCloseTo(102.27, 1);
    expect(alerts).toEqual([]);
  });

  it('refuses to connect to something that is not the card', async () => {
    const { transport } = build(() => ({ ...STATUS, board: 'Some Other Board' }));
    await expect(transport.connect()).rejects.toThrow(/did not identify itself/);
  });

  it('warns before free memory reaches the limit when it keeps falling', async () => {
    let heapKb = 100;
    const { transport, app, tick } = build(() => ({ ...STATUS, heap: Math.round(heapKb * 1024) }));
    await transport.connect();
    const alerts = [];
    app.bus.on('alert:accepted', (a) => alerts.push(a));
    for (let i = 0; i < 14; i++) { heapKb -= 2; await tick(); }
    const alert = alerts.find((a) => a.type === 'METRIC_PREDICTED');
    expect(alert).toBeTruthy();
    expect(alert.message).toMatch(/^Free memory forecast to cross 40 KB in ~\d+s \(confidence \d+%\)\.$/);
  });
});
