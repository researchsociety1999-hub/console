/**
 * CardBleTransport - Web Bluetooth GATT client for the card.
 *
 * Like the Wi-Fi transport, this contains no UUIDs or packet layouts. They must come from a
 * descriptor filled in from evidence (firmware source, vendor documentation, or a BLE
 * explorer such as nRF Connect). Selecting "any nearby device" is deliberately impossible:
 * at least one filter is required, and the descriptor must supply verifyDevice() to prove
 * the chosen device really is the Joker card before any telemetry is trusted.
 */

import { LatestPacketStore, requireFunction, requirePositiveNumber, validateIdentity, withProvenance } from './shared.js';

export function validateBleDescriptor(descriptor) {
  if (!descriptor || descriptor.kind !== 'ble') {
    throw new Error('No BLE card protocol descriptor is configured.');
  }
  if (!Array.isArray(descriptor.filters) || descriptor.filters.length === 0) {
    throw new Error('BLE card protocol descriptor needs at least one device filter (services, name or namePrefix). Accepting all devices is not allowed.');
  }
  for (const filter of descriptor.filters) {
    const hasServices = Array.isArray(filter?.services) && filter.services.length > 0;
    const hasName = typeof filter?.name === 'string' || typeof filter?.namePrefix === 'string';
    if (!hasServices && !hasName) throw new Error('Each BLE filter must set services, name or namePrefix.');
  }
  requireFunction(descriptor.verifyDevice, 'verifyDevice');

  const telemetry = descriptor.telemetry;
  if (!telemetry || (telemetry.mode !== 'notify' && telemetry.mode !== 'read')) {
    throw new Error('Card protocol descriptor telemetry.mode must be "notify" or "read".');
  }
  for (const key of ['service', 'characteristic']) {
    if (typeof telemetry[key] !== 'string' || !telemetry[key]) {
      throw new Error(`Card protocol descriptor is missing telemetry.${key}.`);
    }
  }
  requireFunction(telemetry.parse, 'telemetry.parse');
  requireFunction(telemetry.validate, 'telemetry.validate');
  requirePositiveNumber(telemetry.staleAfterMs, 'telemetry.staleAfterMs');
}

export class CardBleTransport {
  constructor({ descriptor, bluetooth, now = Date.now } = {}) {
    this.name = 'Card BLE';
    this.descriptor = descriptor;
    this.bluetooth = bluetooth ?? globalThis.navigator?.bluetooth ?? null;
    this.now = now;

    this._generation = 0;
    this._connected = false;
    this._device = null;
    this._characteristic = null;
    this._identity = null;
    this._store = null;
    this._onValue = null;
    this._onGattDisconnected = null;
    this._handlers = new Set();
    this.rejectedPackets = 0;
  }

  /** Must be called from a user gesture (for example the Connect button click). */
  async connect() {
    validateBleDescriptor(this.descriptor);
    if (!this.bluetooth || typeof this.bluetooth.requestDevice !== 'function') {
      throw new Error('Web Bluetooth is unavailable. Use a Chromium-based browser over HTTPS or localhost.');
    }

    await this._reset();
    const generation = this._generation;
    const telemetry = this.descriptor.telemetry;
    this._store = new LatestPacketStore({ staleAfterMs: telemetry.staleAfterMs, now: this.now });

    try {
      const device = await this.bluetooth.requestDevice({
        filters: this.descriptor.filters,
        optionalServices: [...new Set([telemetry.service, ...(this.descriptor.optionalServices ?? [])])]
      });
      this._device = device;
      this._onGattDisconnected = () => this._handleUnexpectedDisconnect(generation);
      device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

      const server = await device.gatt.connect();
      const identity = validateIdentity(await this.descriptor.verifyDevice({ device, server }));
      if (!identity) throw new Error('The selected Bluetooth device did not verify as the Joker card.');

      const service = await server.getPrimaryService(telemetry.service);
      const characteristic = await service.getCharacteristic(telemetry.characteristic);
      this._characteristic = characteristic;

      if (telemetry.mode === 'notify') {
        if (!characteristic.properties?.notify) throw new Error('The configured characteristic does not support notifications.');
        this._onValue = (event) => {
          if (generation === this._generation) this._ingest(event.target.value);
        };
        characteristic.addEventListener('characteristicvaluechanged', this._onValue);
        await characteristic.startNotifications();
      } else if (!characteristic.properties?.read) {
        throw new Error('The configured characteristic does not support reads.');
      }

      if (generation !== this._generation) throw new Error('Connection attempt was cancelled.');
      this._identity = identity;
      this._connected = true;
      return { connected: true, deviceId: identity.id, deviceName: identity.name };
    } catch (error) {
      if (generation === this._generation) await this._reset();
      throw error;
    }
  }

  async disconnect() {
    await this._reset();
  }

  onDisconnect(handler) {
    if (typeof handler !== 'function') return () => {};
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  /** Returns the latest validated, fresh packet (with provenance) or null. Never fabricates. */
  async sample() {
    if (!this._connected) return null;
    const generation = this._generation;

    if (this.descriptor.telemetry.mode === 'read') {
      try {
        const value = await this._characteristic.readValue();
        if (generation !== this._generation) return null; // finished after disconnect: discard
        if (!this._ingest(value)) this._store.clear();
      } catch (error) {
        if (generation !== this._generation) return null;
        this._store.clear();
        throw error;
      }
    }

    const entry = this._store.fresh();
    return entry ? withProvenance(entry, 'card-ble', this._identity) : null;
  }

  // ---- internals ----

  _ingest(dataView) {
    const telemetry = this.descriptor.telemetry;
    try {
      const packet = telemetry.parse(dataView);
      if (packet === null || packet === undefined) return false;
      this._store.set(telemetry.validate(packet));
      return true;
    } catch {
      this.rejectedPackets += 1;
      return false;
    }
  }

  _handleUnexpectedDisconnect(generation) {
    if (generation !== this._generation || !this._connected) return;
    this._connected = false;
    this._generation += 1;
    this._store?.clear();
    this._identity = null;
    for (const handler of [...this._handlers]) {
      try { handler(); } catch { /* handler errors must not break cleanup */ }
    }
  }

  async _reset() {
    this._generation += 1;
    const device = this._device;
    const characteristic = this._characteristic;
    this._device = null;
    this._characteristic = null;
    this._connected = false;
    this._identity = null;
    this._store?.clear();

    if (characteristic && this._onValue) {
      characteristic.removeEventListener('characteristicvaluechanged', this._onValue);
      try { await characteristic.stopNotifications?.(); } catch { /* best effort */ }
    }
    if (device && this._onGattDisconnected) {
      device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
    }
    try {
      if (device?.gatt?.connected) device.gatt.disconnect();
    } catch { /* best effort */ }
    this._onValue = null;
    this._onGattDisconnected = null;
  }
}
