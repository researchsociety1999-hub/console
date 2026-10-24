import { CardWifiTransport } from './card-wifi-transport.js';
import { CardBleTransport } from './card-ble-transport.js';

/**
 * Builds the real transport for a descriptor. Returns null when no descriptor is configured,
 * so the adapter stays disconnected instead of falling back to anything simulated.
 */
export function createTransportFromDescriptor(descriptor) {
  if (!descriptor) return null;
  if (descriptor.kind === 'wifi') return new CardWifiTransport({ descriptor });
  if (descriptor.kind === 'ble') return new CardBleTransport({ descriptor });
  throw new Error(`Unknown card protocol descriptor kind: ${String(descriptor.kind)}`);
}
