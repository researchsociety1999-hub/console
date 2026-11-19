import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runDataFirewall,
  validateModulePacket
} from '../js/data-firewall.js';
import { JokerAdapter } from '../js/joker-adapter.js';
import { CardWifiTransport } from '../js/transports/card-wifi-transport.js';
import { CARD_PROTOCOL } from '../js/transports/card-protocol.js';
import { sendSetState } from '../js/transports/card-commands.js';

function installBrowserMocks() {
  if (typeof globalThis.ImageData === 'undefined') {
    globalThis.ImageData = class ImageData {
      constructor(width = 1, height = 1) {
        this.width = width;
        this.height = height;
        this.data = new Uint8ClampedArray(width * height * 4);
      }
    };
  }

  if (
    typeof HTMLCanvasElement !== 'undefined' &&
    !HTMLCanvasElement.prototype.getContext
  ) {
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      fillRect: vi.fn(),
      clearRect: vi.fn(),
      getImageData: vi.fn(
        (_x, _y, width = 1, height = 1) =>
          new globalThis.ImageData(width, height)
      ),
      putImageData: vi.fn(),
      createImageData: vi.fn(
        (width = 1, height = 1) => new globalThis.ImageData(width, height)
      ),
      setTransform: vi.fn(),
      drawImage: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn()
    }));
  }

  globalThis.requestAnimationFrame =
    globalThis.requestAnimationFrame ||
    ((callback) => setTimeout(() => callback(Date.now()), 16));

  globalThis.cancelAnimationFrame =
    globalThis.cancelAnimationFrame || ((id) => clearTimeout(id));

  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: {}
    });
  }

  if (!globalThis.crypto.subtle) {
    Object.defineProperty(globalThis.crypto, 'subtle', {
      configurable: true,
      value: {
        digest: vi.fn().mockResolvedValue(new ArrayBuffer(32))
      }
    });
  }

  if (typeof navigator !== 'undefined' && !navigator.bluetooth) {
    Object.defineProperty(navigator, 'bluetooth', {
      configurable: true,
      value: {
        requestDevice: vi.fn().mockResolvedValue({ id: 'mock-ble' })
      }
    });
  }

  if (!globalThis.NDEFReader) {
    globalThis.NDEFReader = class NDEFReader {
      scan() {
        return Promise.resolve();
      }

      write() {
        return Promise.resolve();
      }
    };
  }
}

beforeEach(() => {
  installBrowserMocks();
});

describe('Local-Only Architecture & Regression Guard', () => {
  it('validates packets without remote dependencies', () => {
    const packet = {
      id: 'pkt-01',
      payload: { temperature: 24.5 }
    };

    expect(validateModulePacket(packet)).toBe(true);

    const result = runDataFirewall(packet);
    expect(result.allowed).toBe(true);
    expect(result.trustScore).toBeGreaterThanOrEqual(50);
  });

  it('blocks invalid packets locally', () => {
    const result = runDataFirewall({
      anomalyDetected: true,
      pinTampered: true
    });

    expect(result.allowed).toBe(false);
    expect(result.trustScore).toBe(45);
  });

  it('operates the local adapter telemetry bus safely', () => {
    const adapter = new JokerAdapter();
    const thermalGrid = adapter.getThermalGrid();
    const scan = adapter.getRadarScanData();

    expect(Array.isArray(thermalGrid)).toBe(true);
    expect(thermalGrid).toHaveLength(64);
    expect(scan).toHaveProperty('angle');
    expect(Array.isArray(scan.devices)).toBe(true);
  });

  it('supports local profile isolation without browser hardware', () => {
    const adapter = new JokerAdapter();

    adapter.setProfile('diagnostic');
    expect(adapter.activeProfile).toBe('diagnostic');

    const result = adapter.killDevice();
    expect(result.status).toBe('TERMINATED');
    expect(adapter.activeProfile).toBe('isolated');
    expect(adapter.connected).toBe(false);
  });
});

const BOARD = 'SGP Card Joker / ESP32-S3-MINI-1-N8';
const REQUEST = { id: 'c-0007', cmd: 'SET_STATE', rgb: 'joker', color: [0, 255, 0], sound: 'laugh' };
const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

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

describe('SET_STATE command contract (fake network)', () => {
  it('reports success only for a matching id in state applied', async () => {
    const { transport, posts } = await connectedTransport((request) => reply({ lastCommand: { id: request.id, state: 'applied', rgb: 'joker', sound: 'played', appliedAtMs: 91234 } }));
    const ack = await sendSetState(transport, REQUEST);
    expect(ack).toMatchObject({ acknowledged: true, state: 'applied', id: 'c-0007', rgb: 'joker', sound: 'played', appliedAtMs: 91234, attempts: 1 });
    expect(posts).toHaveLength(1);
    expect(posts[0].method).toBe('POST');
    expect(JSON.parse(posts[0].body)).toEqual(REQUEST);
    expect(posts[0].headers['Content-Type']).toContain('text/plain');
  });

  it('rejects with the card reason when the card reports an error, without retrying', async () => {
    const { transport, posts } = await connectedTransport((request) => reply({ lastCommand: { id: request.id, state: 'error', reason: 'LED_BUSY' } }));
    await expect(sendSetState(transport, REQUEST)).rejects.toMatchObject({ code: 'CARD_ERROR', reason: 'LED_BUSY', state: 'error' });
    expect(posts).toHaveLength(1);
  });

  it('gives up with COMMAND_TIMEOUT when the card does not answer within 5 seconds', async () => {
    const { transport } = await connectedTransport((_request, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.useFakeTimers();
    try {
      const pending = sendSetState(transport, REQUEST, { attempts: 1 }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(5000);
      const error = await pending;
      expect(error).toMatchObject({ code: 'COMMAND_TIMEOUT', attempts: 1 });
      expect(error.message).toContain('timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});
