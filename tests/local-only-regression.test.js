import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
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
