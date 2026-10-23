import { beforeEach, describe, expect, it } from 'vitest';
import { CardWifiTransport } from '../js/transports/card-wifi-transport.js';
import { CardBleTransport } from '../js/transports/card-ble-transport.js';

// Test-only doubles stand in for the browser's fetch/WebSocket/Bluetooth APIs. They are not a
// card simulator, and no application module imports them.
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
  drop() { this.onclose?.(); }
}

function makeDescriptor() {
  return {
    kind: 'wifi',
    baseUrl: 'http://card.test',
    identity: {
      path: '/identity',
      responseType: 'json',
      parse: (body) => (body && body.id ? { id: body.id, name: body.name } : null)
    },
    telemetry: {
      mode: 'poll',
      path: '/telemetry',
      responseType: 'json',
      staleAfterMs: 1000,
      parse: (body) => body,
      validate: (packet) => {
        if (!Number.isFinite(packet.value)) throw new Error('invalid packet');
        return packet;
      }
    }
  };
}

function makeSocketDescriptor(telemetryExtra = {}, identityExtra = {}) {
  return {
    kind: 'wifi',
    baseUrl: 'http://card.test',
    identity: {
      from: 'websocket',
      timeoutMs: 1000,
      parse: (frame) => (typeof frame === 'string' && frame.startsWith('id:') ? { id: frame.slice(3), name: 'Joker' } : null),
      ...identityExtra
    },
    telemetry: {
      mode: 'websocket',
      path: '/socket-path',
      staleAfterMs: 1000,
      parse: (frame) => (typeof frame === 'string' && frame.startsWith('v:') ? { value: Number(frame.slice(2)) } : null),
      validate: (packet) => {
        if (!Number.isFinite(packet.value)) throw new Error('invalid packet');
        return packet;
      },
      ...telemetryExtra
    }
  };
}

describe('CardWifiTransport (HTTP)', () => {
  it('refuses to connect without a descriptor', async () => {
    const transport = new CardWifiTransport({ descriptor: null, fetchImpl: async () => jsonResponse({}) });
    await expect(transport.connect()).rejects.toThrow(/No Wi-Fi card protocol descriptor/);
  });

  it('refuses to call a plain-HTTP card from an HTTPS page', async () => {
    const transport = new CardWifiTransport({ descriptor: makeDescriptor(), fetchImpl: async () => jsonResponse({}), pageProtocol: 'https:' });
    await expect(transport.connect()).rejects.toThrow(/plain-HTTP/);
  });

  it('rejects a device that does not identify as the card', async () => {
    const transport = new CardWifiTransport({ descriptor: makeDescriptor(), fetchImpl: async () => jsonResponse({ other: true }), pageProtocol: 'http:' });
    await expect(transport.connect()).rejects.toThrow(/did not identify itself/);
  });

  it('returns only validated packets with provenance, and nothing for invalid ones', async () => {
    let call = 0;
    const bodies = [{ id: 'card-1', name: 'Joker' }, { value: 5 }, { value: 'x' }];
    const fetchImpl = async () => jsonResponse(bodies[call++]);
    const transport = new CardWifiTransport({ descriptor: makeDescriptor(), fetchImpl, pageProtocol: 'http:' });

    const result = await transport.connect();
    expect(result).toEqual({ connected: true, deviceId: 'card-1', deviceName: 'Joker' });

    const good = await transport.sample();
    expect(good.value).toBe(5);
    expect(good.provenance.source).toBe('card-wifi');
    expect(good.provenance.deviceId).toBe('card-1');

    expect(await transport.sample()).toBeNull();
    expect(transport.rejectedPackets).toBe(1);
  });

  it('discards a read that finishes after disconnect', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let call = 0;
    const fetchImpl = async () => {
      call += 1;
      if (call === 1) return jsonResponse({ id: 'card-1', name: 'Joker' });
      await gate;
      return jsonResponse({ value: 1 });
    };
    const transport = new CardWifiTransport({ descriptor: makeDescriptor(), fetchImpl, pageProtocol: 'http:' });
    await transport.connect();

    const pending = transport.sample();
    await transport.disconnect();
    release();
    expect(await pending).toBeNull();
    expect(await transport.sample()).toBeNull();
  });

  it('refuses commands unless the descriptor allows them', async () => {
    const transport = new CardWifiTransport({
      descriptor: makeDescriptor(),
      fetchImpl: async () => jsonResponse({ id: 'card-1', name: 'Joker' }),
      pageProtocol: 'http:'
    });
    await transport.connect();
    await expect(transport.invokeCommand('anything')).rejects.toThrow(/Commands are disabled/);
  });
});

describe('CardWifiTransport (WebSocket)', () => {
  beforeEach(() => {
    FakeWebSocket.instances.length = 0;
  });

  const make = (descriptor) => new CardWifiTransport({ descriptor, WebSocketImpl: FakeWebSocket, pageProtocol: 'http:' });

  it('connects only after a frame identifies the card, and then returns validated frames', async () => {
    const transport = make(makeSocketDescriptor());
    const connecting = transport.connect();
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe('ws://card.test/socket-path');

    socket.open();
    socket.message('id:card-9');
    expect(await connecting).toEqual({ connected: true, deviceId: 'card-9', deviceName: 'Joker' });

    socket.message('v:21');
    const packet = await transport.sample();
    expect(packet.value).toBe(21);
    expect(packet.provenance).toMatchObject({ source: 'card-wifi', deviceId: 'card-9' });

    socket.message('v:not-a-number');
    expect(transport.rejectedPackets).toBe(1);
  });

  it('fails when the card never identifies itself', async () => {
    const transport = make(makeSocketDescriptor({}, { timeoutMs: 20 }));
    const connecting = transport.connect();
    FakeWebSocket.instances[0].open();
    await expect(connecting).rejects.toThrow(/did not identify itself over the WebSocket/);
    expect(await transport.sample()).toBeNull();
  });

  it('sends the descriptor opening messages once the socket opens', async () => {
    const transport = make(makeSocketDescriptor({ openMessages: ['hello-from-descriptor'] }));
    const connecting = transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message('id:card-9');
    await connecting;
    expect(socket.sent).toEqual(['hello-from-descriptor']);
  });

  it('notifies the disconnect handler when the socket closes, and returns no stale data', async () => {
    const transport = make(makeSocketDescriptor());
    let lost = 0;
    transport.onDisconnect(() => { lost += 1; });
    const connecting = transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message('id:card-9');
    await connecting;
    socket.message('v:3');

    socket.drop();
    expect(lost).toBe(1);
    expect(await transport.sample()).toBeNull();
  });

  it('treats a silent socket as a lost link', async () => {
    const transport = make(makeSocketDescriptor({ silenceDisconnectMs: 20 }));
    let lost = 0;
    transport.onDisconnect(() => { lost += 1; });
    const connecting = transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message('id:card-9');
    await connecting;

    await sleep(80);
    expect(lost).toBe(1);
    expect(await transport.sample()).toBeNull();
  });
});

describe('CardBleTransport', () => {
  it('refuses wildcard device selection', async () => {
    const transport = new CardBleTransport({
      descriptor: { kind: 'ble', filters: [] },
      bluetooth: { requestDevice: async () => { throw new Error('requestDevice must not be called'); } }
    });
    await expect(transport.connect()).rejects.toThrow(/at least one device filter/);
  });

  it('reports when Web Bluetooth is unavailable', async () => {
    const transport = new CardBleTransport({
      descriptor: {
        kind: 'ble',
        filters: [{ namePrefix: 'test' }],
        verifyDevice: async () => null,
        telemetry: { mode: 'notify', service: 'svc', characteristic: 'chr', staleAfterMs: 1000, parse: () => null, validate: (p) => p }
      },
      bluetooth: null
    });
    await expect(transport.connect()).rejects.toThrow(/Web Bluetooth is unavailable/);
  });
});
