/**
 * CardWifiTransport - talks to the card over the network (its own access point / web panel).
 *
 * This class contains NO knowledge of the card's endpoints or payloads. Everything
 * protocol-specific comes from a descriptor (see card-protocol.js) that must be filled
 * in from captured evidence (tools/panel-sniffer.js or a HAR export).
 * It never fabricates data: without a valid descriptor, identity handshake and
 * validated packets, connect() fails and sample() returns null.
 */

import { LatestPacketStore, requireFunction, requirePositiveNumber, validateIdentity, withProvenance } from './shared.js';

const FETCH_TIMEOUT_MS = 5000;
const DEFAULT_FAILURE_LIMIT = 3;
const RESPONSE_TYPES = ['json', 'text', 'arrayBuffer'];

function validateRequestSpec(spec, label) {
  if (!spec || typeof spec.path !== 'string' || !spec.path) {
    throw new Error(`Card protocol descriptor is missing ${label}.path.`);
  }
  if (!RESPONSE_TYPES.includes(spec.responseType)) {
    throw new Error(`Card protocol descriptor ${label}.responseType must be one of: ${RESPONSE_TYPES.join(', ')}.`);
  }
}

export function validateWifiDescriptor(descriptor) {
  if (!descriptor || descriptor.kind !== 'wifi') {
    throw new Error('No Wi-Fi card protocol descriptor is configured.');
  }
  let base;
  try {
    base = new URL(descriptor.baseUrl);
  } catch {
    throw new Error('Card protocol descriptor baseUrl is not a valid URL.');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Card protocol descriptor baseUrl must use http: or https:.');
  }
  validateRequestSpec(descriptor.identity, 'identity');
  requireFunction(descriptor.identity.parse, 'identity.parse');

  const telemetry = descriptor.telemetry;
  if (!telemetry || (telemetry.mode !== 'poll' && telemetry.mode !== 'websocket')) {
    throw new Error('Card protocol descriptor telemetry.mode must be "poll" or "websocket".');
  }
  if (telemetry.mode === 'poll') validateRequestSpec(telemetry, 'telemetry');
  else if (typeof telemetry.path !== 'string' || !telemetry.path) {
    throw new Error('Card protocol descriptor is missing telemetry.path.');
  }
  requireFunction(telemetry.parse, 'telemetry.parse');
  requireFunction(telemetry.validate, 'telemetry.validate');
  requirePositiveNumber(telemetry.staleAfterMs, 'telemetry.staleAfterMs');
  return base;
}

export class CardWifiTransport {
  constructor({ descriptor, fetchImpl, WebSocketImpl, pageProtocol, now = Date.now } = {}) {
    this.name = 'Card Wi-Fi';
    this.descriptor = descriptor;
    this.fetchImpl = fetchImpl ?? (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.WebSocketImpl = WebSocketImpl ?? globalThis.WebSocket;
    this.pageProtocol = pageProtocol ?? globalThis.location?.protocol ?? null;
    this.now = now;

    this._generation = 0;
    this._connected = false;
    this._baseUrl = null;
    this._identity = null;
    this._store = null;
    this._socket = null;
    this._failures = 0;
    this._inflight = new Set();
    this._handlers = new Set();
    this.rejectedPackets = 0;
  }

  async connect() {
    const base = validateWifiDescriptor(this.descriptor);
    if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable in this browser.');
    if (this.pageProtocol === 'https:' && base.protocol === 'http:') {
      throw new Error(
        "This page is served over HTTPS, so the browser blocks requests to the card's plain-HTTP address. " +
        "Run the dashboard from http://localhost on a computer joined to the card's Wi-Fi."
      );
    }

    this._reset();
    const generation = this._generation;
    const telemetry = this.descriptor.telemetry;
    this._baseUrl = base;
    this._store = new LatestPacketStore({ staleAfterMs: telemetry.staleAfterMs, now: this.now });

    try {
      const identityBody = await this._fetchBody(this.descriptor.identity);
      this._assertCurrent(generation);
      const identity = validateIdentity(this.descriptor.identity.parse(identityBody));
      if (!identity) throw new Error('The device at this address did not identify itself as the Joker card.');

      if (telemetry.mode === 'websocket') await this._openSocket(base, generation);
      this._assertCurrent(generation);

      this._identity = identity;
      this._connected = true;
      return { connected: true, deviceId: identity.id, deviceName: identity.name };
    } catch (error) {
      if (generation === this._generation) this._reset();
      throw error;
    }
  }

  async disconnect() {
    this._reset();
  }

  /** Registers a handler for unexpected link loss. Returns an unsubscribe function. */
  onDisconnect(handler) {
    if (typeof handler !== 'function') return () => {};
    this._handlers.add(handler);
    return () => this._handlers.delete(handler);
  }

  /** Returns the latest validated, fresh packet (with provenance) or null. Never fabricates. */
  async sample() {
    if (!this._connected) return null;
    const generation = this._generation;
    const telemetry = this.descriptor.telemetry;

    if (telemetry.mode === 'poll') {
      let body;
      try {
        body = await this._fetchBody(telemetry);
      } catch (error) {
        if (generation !== this._generation) return null;
        this._store.clear();
        this._failures += 1;
        if (this._failures >= (telemetry.disconnectAfterFailures ?? DEFAULT_FAILURE_LIMIT)) {
          this._handleUnexpectedDisconnect();
        }
        throw error;
      }
      if (generation !== this._generation) return null; // read finished after disconnect: discard
      this._failures = 0;
      if (!this._ingest(body)) this._store.clear();
    }

    const entry = this._store.fresh();
    return entry ? withProvenance(entry, 'card-wifi', this._identity) : null;
  }

  /**
   * Sends a command only if the descriptor explicitly allows commands AND defines this one,
   * and returns only when the card's acknowledgement parses as acknowledged: true.
   */
  async invokeCommand(name, params = {}) {
    if (!this._connected) throw new Error('Connect to the card before sending commands.');
    if (this.descriptor.allowCommands !== true) throw new Error('Commands are disabled by the card protocol descriptor.');
    const spec = this.descriptor.commands?.[name];
    if (!spec) throw new Error(`The card protocol descriptor does not define a "${name}" command.`);
    validateRequestSpec(spec, `commands.${name}`);
    if (typeof spec.method !== 'string' || !spec.method) throw new Error(`commands.${name}.method is required.`);
    requireFunction(spec.buildBody, `commands.${name}.buildBody`);
    requireFunction(spec.parseAck, `commands.${name}.parseAck`);

    const generation = this._generation;
    const response = await this._fetchBody(spec, { method: spec.method, body: spec.buildBody(params), headers: spec.headers });
    this._assertCurrent(generation);
    const ack = spec.parseAck(response);
    if (!ack || ack.acknowledged !== true) throw new Error(`The card did not acknowledge the "${name}" command.`);
    return ack;
  }

  // ---- internals ----

  _assertCurrent(generation) {
    if (generation !== this._generation) throw new Error('Connection attempt was cancelled.');
  }

  async _fetchBody(spec, { method = 'GET', body, headers } = {}) {
    const controller = new AbortController();
    this._inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = new URL(spec.path, this._baseUrl).href;
      const response = await this.fetchImpl(url, { method, body, headers, signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`The card returned HTTP ${response.status} for ${spec.path}.`);
      return await response[spec.responseType]();
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Request to ${spec.path} timed out or was cancelled.`);
      throw error;
    } finally {
      clearTimeout(timer);
      this._inflight.delete(controller);
    }
  }

  _ingest(raw) {
    const telemetry = this.descriptor.telemetry;
    try {
      const packet = telemetry.parse(raw);
      if (packet === null || packet === undefined) return false;
      this._store.set(telemetry.validate(packet));
      return true;
    } catch {
      this.rejectedPackets += 1;
      return false;
    }
  }

  _openSocket(base, generation) {
    const telemetry = this.descriptor.telemetry;
    const WS = this.WebSocketImpl;
    if (typeof WS !== 'function') return Promise.reject(new Error('WebSocket is unavailable in this browser.'));
    const url = new URL(telemetry.path, base);
    url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';

    return new Promise((resolve, reject) => {
      const socket = new WS(url.href);
      socket.binaryType = 'arraybuffer';
      const timer = setTimeout(() => {
        try { socket.close(); } catch { /* best effort */ }
        reject(new Error('Timed out opening the card WebSocket.'));
      }, FETCH_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(timer);
        if (generation !== this._generation) {
          try { socket.close(); } catch { /* best effort */ }
          reject(new Error('Connection attempt was cancelled.'));
          return;
        }
        this._socket = socket;
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('The card WebSocket reported an error.'));
      };
      socket.onmessage = (event) => {
        if (generation === this._generation) this._ingest(event.data);
      };
      socket.onclose = () => {
        if (generation === this._generation && this._socket === socket) this._handleUnexpectedDisconnect();
      };
    });
  }

  _handleUnexpectedDisconnect() {
    if (!this._connected) return;
    this._reset();
    for (const handler of [...this._handlers]) {
      try { handler(); } catch { /* handler errors must not break cleanup */ }
    }
  }

  _reset() {
    this._generation += 1;
    for (const controller of this._inflight) controller.abort();
    this._inflight.clear();
    const socket = this._socket;
    this._socket = null;
    if (socket) {
      socket.onopen = socket.onerror = socket.onmessage = socket.onclose = null;
      try { socket.close(); } catch { /* best effort */ }
    }
    this._store?.clear();
    this._connected = false;
    this._identity = null;
    this._failures = 0;
  }
}
