import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeTrustScore,
  runDataFirewall,
  validateModulePacket
} from '../js/data-firewall.js';
import { JokerAdapter } from '../js/joker-adapter.js';

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

describe('Console Core Logic & Adapter Contract', () => {
  it('exports required firewall helper functions', () => {
    expect(typeof validateModulePacket).toBe('function');
    expect(typeof computeTrustScore).toBe('function');
    expect(typeof runDataFirewall).toBe('function');
  });

  it('validates a minimal module packet', () => {
    expect(validateModulePacket(null)).toBe(false);
    expect(validateModulePacket({})).toBe(false);
    expect(validateModulePacket({ id: 'module-01' })).toBe(true);
    expect(validateModulePacket({ type: 'TELEMETRY' })).toBe(true);
    expect(validateModulePacket({ payload: {} })).toBe(true);
  });

  it('computes trust score accurately', () => {
    expect(computeTrustScore({})).toBe(100);
    expect(computeTrustScore({ anomalyDetected: true })).toBe(70);
    expect(
      computeTrustScore({
        anomalyDetected: true,
        unauthorizedBle: true,
        pinTampered: true
      })
    ).toBe(25);
  });

  it('runs the local firewall without remote dependencies', () => {
    const result = runDataFirewall({
      id: 'pkt-01',
      payload: { temperature: 24.5 }
    });

    expect(result.allowed).toBe(true);
    expect(result.trustScore).toBe(100);
    expect(typeof result.timestamp).toBe('number');
  });

  it('supports JokerAdapter setProfile and killDevice methods', async () => {
    const adapter = new JokerAdapter();

    expect(typeof adapter.setProfile).toBe('function');
    expect(typeof adapter.killDevice).toBe('function');

    await adapter.connect();
    expect(adapter.connected).toBe(true);

    expect(adapter.setProfile('stealth')).toEqual({
      success: true,
      profile: 'stealth'
    });

    expect(adapter.killDevice()).toEqual({
      success: true,
      status: 'TERMINATED'
    });

    expect(adapter.connected).toBe(false);
    expect(adapter.activeProfile).toBe('isolated');
  });
});
