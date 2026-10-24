import { beforeEach, describe, expect, it } from 'vitest';
import { createFrameParser, createIdentityParser } from '../js/transports/frame-parser.js';
import { CardWifiTransport } from '../js/transports/card-wifi-transport.js';

// Test-only specs with made-up field names. They say nothing about the real card's protocol.

class FakeWebSocket {
  static instances = [];
  constructor(url) { this.url = url; FakeWebSocket.instances.push(this); }
  send() {}
  close() {}
  open() { this.onopen?.(); }
  message(data) { this.onmessage?.({ data }); }
}

describe('createFrameParser (json)', () => {
  const spec = {
    format: 'json',
    match: (m) => m.kind === 'sample',
    fields: {
      level: { type: 'number', path: 'data.level', min: 0, max: 100 },
      label: { type: 'string', path: 'data.label', required: false },
      half: { type: 'number', path: 'data.raw', scale: 0.5, required: false }
    }
  };
  const { parse, validate } = createFrameParser(spec);

  it('ignores frames that are not telemetry', () => {
    expect(parse('{"kind":"other"}')).toBeNull();
    expect(parse('not json')).toBeNull();
    expect(parse(new ArrayBuffer(2))).toBeNull();
  });

  it('extracts typed fields and leaves missing ones missing', () => {
    expect(parse('{"kind":"sample","data":{"level":42,"raw":10}}')).toEqual({ level: 42, half: 5 });
    expect(parse('{"kind":"sample","data":{"level":42}}')).toEqual({ level: 42 });
  });

  it('does not turn strings into numbers for JSON frames', () => {
    const packet = parse('{"kind":"sample","data":{"level":"42"}}');
    expect(packet).toEqual({});
    expect(() => validate(packet)).toThrow(/Missing field "level"/);
  });

  it('validates required fields and ranges', () => {
    expect(() => validate({})).toThrow(/Missing field "level"/);
    expect(() => validate({ level: 101 })).toThrow(/out of range/);
    expect(validate({ level: 5 })).toEqual({ level: 5 });
  });

  it('rejects a spec without a match function or valid format', () => {
    expect(() => createFrameParser({ format: 'xml', fields: {} })).toThrow(/format/);
    expect(() => createFrameParser({ format: 'json', fields: { a: { type: 'number', path: 'a' } } })).toThrow(/match/);
  });
});

describe('createFrameParser (binary)', () => {
  const { parse, validate } = createFrameParser({
    format: 'binary',
    littleEndian: true,
    match: (view) => view.byteLength >= 3,
    fields: {
      a: { type: 'number', kind: 'u16', offset: 0 },
      b: { type: 'number', kind: 'i8', offset: 2, min: -10, max: 10 }
    }
  });

  it('reads fixed-position fields with the declared byte order', () => {
    const packet = parse(new Uint8Array([0x34, 0x12, 0xfe]).buffer);
    expect(packet).toEqual({ a: 0x1234, b: -2 });
    expect(validate(packet)).toEqual(packet);
  });

  it('ignores short frames and rejects out-of-range values', () => {
    expect(parse(new Uint8Array([1, 2]).buffer)).toBeNull();
    expect(() => validate({ a: 1, b: 11 })).toThrow(/out of range/);
  });
});

describe('createFrameParser (text)', () => {
  const { parse, validate } = createFrameParser({
    format: 'text',
    pattern: /^lvl=(?<level>-?\d+(?:\.\d+)?)$/,
    match: (text) => text.startsWith('lvl='),
    fields: { level: { type: 'number', group: 'level' } }
  });

  it('extracts numbers from text frames and reports a malformed value as missing', () => {
    expect(parse('lvl=3.5')).toEqual({ level: 3.5 });
    expect(() => validate(parse('lvl=abc'))).toThrow(/Missing field "level"/);
    expect(parse('other')).toBeNull();
  });
});

describe('createIdentityParser', () => {
  const parseIdentity = createIdentityParser({
    format: 'json',
    match: (m) => m.hello === true,
    id: { type: 'string', path: 'id' },
    name: { type: 'string', path: 'name' },
    verify: ({ name }) => name === 'Test Device'
  });

  it('returns an identity only for a matching frame that passes verify', () => {
    expect(parseIdentity('{"hello":true,"id":"x1","name":"Test Device"}')).toEqual({ id: 'x1', name: 'Test Device' });
    expect(parseIdentity('{"hello":true,"id":"x1","name":"Other"}')).toBeNull();
    expect(parseIdentity('{"hello":true,"name":"Test Device"}')).toBeNull();
    expect(parseIdentity('{"hello":false}')).toBeNull();
  });
});

describe('parsers with the WebSocket transport', () => {
  beforeEach(() => { FakeWebSocket.instances.length = 0; });

  it('connects only after the identity frame and then serves validated telemetry', async () => {
    const descriptor = {
      kind: 'wifi',
      baseUrl: 'http://card.test',
      identity: {
        from: 'websocket',
        timeoutMs: 1000,
        parse: createIdentityParser({
          format: 'json',
          match: (m) => m.hello === true,
          id: { type: 'string', path: 'id' },
          name: { type: 'string', path: 'name' },
          verify: ({ name }) => name === 'Test Device'
        })
      },
      telemetry: {
        mode: 'websocket',
        path: '/p',
        staleAfterMs: 1000,
        ...createFrameParser({
          format: 'json',
          match: (m) => m.kind === 'sample',
          fields: { level: { type: 'number', path: 'data.level', min: 0, max: 100 } }
        })
      }
    };
    const transport = new CardWifiTransport({ descriptor, WebSocketImpl: FakeWebSocket, pageProtocol: 'http:' });
    const connecting = transport.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message('{"kind":"sample","data":{"level":3}}'); // telemetry before identity does not connect it
    socket.message('{"hello":true,"id":"x1","name":"Test Device"}');
    expect(await connecting).toEqual({ connected: true, deviceId: 'x1', deviceName: 'Test Device' });

    socket.message('{"kind":"sample","data":{"level":7}}');
    const packet = await transport.sample();
    expect(packet.level).toBe(7);
    expect(packet.provenance.deviceId).toBe('x1');

    socket.message('{"kind":"sample","data":{"level":500}}'); // out of range: rejected, previous value stays only until it goes stale
    expect(transport.rejectedPackets).toBe(1);
  });
});
