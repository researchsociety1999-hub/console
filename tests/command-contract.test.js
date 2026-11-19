import { describe, expect, it, vi } from 'vitest';
import { CARD_PROTOCOL } from '../js/transports/card-protocol.js';
import { CARD_MAPPING, mapCardPacketToConsoleSample } from '../js/transports/card-mapping.js';
import { CardWifiTransport } from '../js/transports/card-wifi-transport.js';
import { createRequestId, mapCommandResponse, sendSetState } from '../js/transports/card-commands.js';
import { HEADER_GPIO_PINS, validateCommandRequest } from '../js/command-rules.js';
import { JokerAdapter } from '../js/joker-adapter.js';

const BOARD = 'SGP Card Joker / ESP32-S3-MINI-1-N8';
const REQUEST = { id: 'c-0007', cmd: 'SET_STATE', rgb: 'joker', color: [0, 255, 0], sound: 'laugh' };
const STATUS_MIN = { board: BOARD, mac: 'removed', uptime: '00:01:19', heap: 104720, minHeap: 90724, clients: 1, channel: 6 };
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
const applied = (id) => reply({ lastCommand: { id, state: 'applied', rgb: 'joker', sound: 'played', appliedAtMs: 91234 } });

async function connectedTransport(onCommand) {
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === '/api/status') return reply({ board: BOARD, mac: 'removed' });
    if (path === '/api/command') {
      posts.push(init);
      return onCommand(JSON.parse(init.body), init);
    }
    return reply({}, 404);
  };
  const transport = new CardWifiTransport({ descriptor: CARD_PROTOCOL, fetchImpl, pageProtocol: 'http:' });
  await transport.connect();
  return { transport, posts };
}

describe('command rules', () => {
  it('accepts the contract example', () => {
    expect(validateCommandRequest(REQUEST)).toEqual({ ok: true });
  });

  it('rejects bad requests with a reason', () => {
    const cases = [
      [{ ...REQUEST, id: 'x-1' }, 'INVALID_COMMAND_ID'],
      [{ ...REQUEST, cmd: 'SET_GPIO' }, 'COMMAND_NOT_ALLOWED'],
      [{ ...REQUEST, extra: 1 }, 'UNEXPECTED_FIELDS'],
      [{ id: 'c-1', cmd: 'SET_STATE' }, 'NOTHING_TO_SET'],
      [{ ...REQUEST, rgb: 'disco' }, 'INVALID_RGB_MODE'],
      [{ ...REQUEST, sound: 'siren' }, 'INVALID_SOUND'],
      [{ ...REQUEST, color: [0, 256, 0] }, 'INVALID_COLOR'],
      [null, 'NOT_AN_OBJECT']
    ];
    for (const [request, reason] of cases) expect(validateCommandRequest(request)).toEqual({ ok: false, reason });
  });

  it('keeps the 14 header pins and builds ids that pass the id rule', () => {
    expect(HEADER_GPIO_PINS).toHaveLength(14);
    expect(HEADER_GPIO_PINS).toContain(48);
    expect(HEADER_GPIO_PINS).not.toContain(5);
    const first = createRequestId();
    expect(first).not.toBe(createRequestId());
    expect(validateCommandRequest({ id: first, cmd: 'SET_STATE', rgb: 'off' })).toEqual({ ok: true });
  });
});

describe('status field and mapping', () => {
  const parse = (body) => CARD_PROTOCOL.telemetry.validate(CARD_PROTOCOL.telemetry.parse(JSON.stringify(body)));
  const LAST = { id: 'c-0007', state: 'applied', rgb: 'joker', sound: 'played', appliedAtMs: 91234 };

  it('maps lastCommand when the card reports one', () => {
    const packet = parse({ ...STATUS_MIN, lastCommand: LAST });
    expect(CARD_MAPPING.mapPacket(packet).lastCommand).toEqual(LAST);
    expect(mapCardPacketToConsoleSample(packet).lastCommand).toEqual(LAST);
  });

  it('has no lastCommand when the card reports none', () => {
    const packet = parse(STATUS_MIN);
    expect('lastCommand' in CARD_MAPPING.mapPacket(packet)).toBe(false);
    expect(mapCardPacketToConsoleSample(packet).lastCommand).toBeNull();
  });

  it('rejects an unknown command state', () => {
    expect(() => parse({ ...STATUS_MIN, lastCommand: { id: 'c-1', state: 'maybe' } })).toThrow('unexpected value');
  });

  it('maps command states to console statuses', () => {
    expect(mapCommandResponse(LAST)).toMatchObject({ commandId: 'c-0007', commandStatus: 'OK', rgbState: 'joker', soundState: 'played', appliedAtMs: 91234 });
    expect(mapCommandResponse({ id: 'c-1', state: 'error', reason: 'LED_BUSY' })).toMatchObject({ commandStatus: 'ERROR', reason: 'LED_BUSY' });
    expect(mapCommandResponse({ id: 'c-1', state: 'pending' }).commandStatus).toBe('PENDING');
    expect(mapCommandResponse({ id: 'c-1', state: 'maybe' })).toBeNull();
    expect(mapCommandResponse(null)).toBeNull();
  });
});

describe('sendSetState', () => {
  it('rejects a response for a different command id', async () => {
    const { transport } = await connectedTransport(() => applied('c-other'));
    await expect(sendSetState(transport, REQUEST)).rejects.toMatchObject({ code: 'ID_MISMATCH' });
  });

  it('reports pending as PENDING, not as success', async () => {
    const { transport } = await connectedTransport((request) => reply({ lastCommand: { id: request.id, state: 'pending' } }));
    await expect(sendSetState(transport, REQUEST)).rejects.toMatchObject({ code: 'PENDING', id: 'c-0007' });
  });

  it('retries network failures with the same id and then succeeds', async () => {
    let calls = 0;
    const { transport, posts } = await connectedTransport((request) => {
      calls += 1;
      if (calls < 3) throw new TypeError('Failed to fetch');
      return applied(request.id);
    });
    const ack = await sendSetState(transport, REQUEST);
    expect(ack.attempts).toBe(3);
    expect(posts).toHaveLength(3);
    expect(posts.every((post) => JSON.parse(post.body).id === 'c-0007')).toBe(true);
  });

  it('gives up after 3 failed attempts', async () => {
    const { transport, posts } = await connectedTransport(() => { throw new TypeError('Failed to fetch'); });
    await expect(sendSetState(transport, REQUEST)).rejects.toMatchObject({ code: 'COMMAND_TIMEOUT', attempts: 3 });
    expect(posts).toHaveLength(3);
  });

  it('does not retry an HTTP 404 (firmware without the endpoint)', async () => {
    const { transport, posts } = await connectedTransport(() => reply({}, 404));
    await expect(sendSetState(transport, REQUEST)).rejects.toThrow('HTTP 404');
    expect(posts).toHaveLength(1);
  });

  it('rejects an invalid request locally without touching the network', async () => {
    const { transport, posts } = await connectedTransport(() => applied('c-1'));
    await expect(sendSetState(transport, { ...REQUEST, rgb: 'disco' })).rejects.toMatchObject({ code: 'REJECTED_LOCALLY', reason: 'INVALID_RGB_MODE' });
    expect(posts).toHaveLength(0);
  });
});

describe('JokerAdapter with a live card', () => {
  const liveAdapter = async () => {
    const transport = {
      name: 'Card Wi-Fi',
      connect: async () => ({ deviceId: 'x', deviceName: BOARD }),
      disconnect: async () => {},
      onDisconnect: () => () => {},
      sample: async () => null,
      invokeCommand: vi.fn(async (_name, params) => ({ acknowledged: true, state: 'applied', id: params.id, rgb: params.rgb, sound: 'played' }))
    };
    const adapter = new JokerAdapter();
    adapter.bindTransport(transport, (packet) => packet);
    await adapter.connect({ mode: 'wifi' });
    return { adapter, transport };
  };

  it('returns no thermal, GPIO or radar data instead of generating it', async () => {
    const { adapter } = await liveAdapter();
    expect(await adapter.getSafeAuditTelemetry()).toBeNull();
    expect(adapter.getThermalGrid()).toEqual([]);
    adapter.noteCardClients(3);
    expect(adapter.getRadarScanData().devices).toEqual([]);
  });

  it('refuses simulated hardware actions', async () => {
    const { adapter } = await liveAdapter();
    expect(() => adapter.toggleGpioLine('doorContact')).toThrow('not available from the live card');
    expect(() => adapter.setModuleState('nfc', 'ON')).toThrow('not available from the live card');
    await expect(adapter.triggerModuleSelfTest('gpio')).rejects.toThrow('not available from the live card');
    await expect(adapter.restartModule('nfc')).rejects.toThrow('not available from the live card');
    await expect(adapter.sendBuzzerTone(880, 100)).rejects.toThrow('not available from the live card');
  });

  it('checks the 14 header pins first and then refuses GPIO writes', async () => {
    const { adapter } = await liveAdapter();
    expect(() => adapter.setGpioPin(5, 'HIGH')).toThrow('not a header pin');
    expect(() => adapter.setGpioPin(48, 'HIGH')).toThrow('No GPIO command is defined');
  });

  it('sends RGB and sound as SET_STATE and returns the acknowledgement', async () => {
    const { adapter, transport } = await liveAdapter();
    const rgb = await adapter.setRgbMode('joker');
    expect(rgb.state).toBe('applied');
    expect(transport.invokeCommand).toHaveBeenCalledWith('SET_STATE', expect.objectContaining({ cmd: 'SET_STATE', rgb: 'joker' }));
    const sound = await adapter.playSound('laugh');
    expect(sound.state).toBe('applied');
    expect(transport.invokeCommand).toHaveBeenCalledWith('SET_STATE', expect.objectContaining({ cmd: 'SET_STATE', sound: 'laugh' }));
  });

  it('rejects an invalid state command before the transport is called', async () => {
    const { adapter, transport } = await liveAdapter();
    await expect(adapter.sendStateCommand({ id: 'bad' })).rejects.toMatchObject({ code: 'REJECTED_LOCALLY' });
    expect(transport.invokeCommand).not.toHaveBeenCalled();
  });

  it('reports a live kill as a local disconnect only', async () => {
    const { adapter } = await liveAdapter();
    expect(adapter.killDevice().status).toBe('DISCONNECTED_LOCALLY');
  });

  it('keeps the demo behaviour in demo mode and refuses card commands there', async () => {
    const adapter = new JokerAdapter();
    await adapter.connect();
    expect(adapter.setGpioPin(5, 'HIGH').status).toBe('SET_LOCALLY');
    expect((await adapter.playSound('laugh')).status).toBe('SIMULATED');
    await expect(adapter.sendStateCommand(REQUEST)).rejects.toThrow('live card');
    expect(adapter.killDevice().status).toBe('TERMINATED');
  });
});
