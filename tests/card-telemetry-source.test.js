import { describe, expect, it } from 'vitest';
import { CardTelemetrySource } from '../js/sentinel/CardTelemetrySource.js';
import { SentinelConsole } from '../js/sentinel/SentinelConsole.js';

// Test-only transport doubles: they stand in for a real card transport and are never imported by app code.
const packet = (receivedAt, extra = {}) => ({ battery: 80, ...extra, provenance: { source: 'card-wifi', deviceId: 'card-1', receivedAt } });
const mapBattery = (p) => ({ batteryPct: p.battery });

describe('CardTelemetrySource', () => {
  it('requires a real transport and a mapper', () => {
    expect(() => new CardTelemetrySource({})).toThrow(/real card transport/);
    expect(() => new CardTelemetrySource({ transport: { sample: async () => null } })).toThrow(/mapPacket/);
  });

  it('reports no device when the transport has no fresh packet', async () => {
    const source = new CardTelemetrySource({ transport: { sample: async () => null }, mapPacket: mapBattery });
    expect(await source.detectDevice()).toBe(false);
    expect(source.readRawSample()).toBeNull();
  });

  it('maps a validated packet and stamps it with the receive time', async () => {
    const source = new CardTelemetrySource({ transport: { sample: async () => packet(5000) }, mapPacket: mapBattery });
    expect(await source.detectDevice()).toBe(true);
    expect(source.readRawSample()).toMatchObject({ sourceModule: 'CARD', isPresent: true, isStreaming: true, batteryPct: 80, timestamp: 5000 });
  });

  it('leaves fields the card does not provide undefined', async () => {
    const source = new CardTelemetrySource({ transport: { sample: async () => packet(5000) }, mapPacket: mapBattery });
    await source.detectDevice();
    expect(source.readRawSample().temperatureC).toBeUndefined();
  });

  it('clears the reading when the transport throws', async () => {
    let fail = false;
    const transport = { sample: async () => { if (fail) throw new Error('link lost'); return packet(1); } };
    const source = new CardTelemetrySource({ transport, mapPacket: mapBattery });
    expect(await source.detectDevice()).toBe(true);
    fail = true;
    expect(await source.detectDevice()).toBe(false);
    expect(source.readRawSample()).toBeNull();
    expect(source.lastError.message).toBe('link lost');
  });

  it('rejects packets without a receive time or that the mapper refuses', async () => {
    const noTime = new CardTelemetrySource({ transport: { sample: async () => ({ battery: 80 }) }, mapPacket: mapBattery });
    expect(await noTime.detectDevice()).toBe(false);
    const refused = new CardTelemetrySource({ transport: { sample: async () => packet(1) }, mapPacket: () => null });
    expect(await refused.detectDevice()).toBe(false);
  });

  it('drives SentinelConsole to lost when the card goes quiet and back to manifested when it returns', async () => {
    let live = true;
    const transport = { sample: async () => (live ? packet(Date.now()) : null) };
    const telemetry = new CardTelemetrySource({ transport, mapPacket: mapBattery });
    const app = new SentinelConsole({ telemetry, storage: null });

    await app.runMonitoringCycle();
    expect(app.store.get().cardState).toBe('manifested');
    live = false;
    await app.runMonitoringCycle();
    expect(app.store.get().cardState).toBe('lost');
    live = true;
    await app.runMonitoringCycle();
    expect(app.store.get().cardState).toBe('manifested');
  });
});
