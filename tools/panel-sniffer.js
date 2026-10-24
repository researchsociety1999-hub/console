/**
 * Panel sniffer (read-only). Paste this whole file into the browser DevTools console while
 * viewing the card's own web panel (open the panel first, then paste, then use each panel
 * feature). It logs the panel's requests/messages so the real protocol can be documented.
 * It only observes; it sends nothing of its own.
 *
 * If the panel makes its requests during page load, use DevTools > Network > Save all as HAR
 * instead (reload with the Network tab already open).
 *
 * Afterwards run:  copy(__cardSniffer.dump())
 * Secrets in headers are never logged; body fields that look like secrets are redacted.
 * Still review the output before sharing it.
 */
(() => {
  if (window.__cardSniffer) {
    console.warn('Panel sniffer is already installed.');
    return;
  }

  const MAX_BODY = 400;
  const SECRET = /(pass(word|phrase)?|secret|token|auth|cookie|key|pin|ssid)/i;
  const log = [];
  const push = (entry) => log.push({ t: new Date().toISOString(), ...entry });

  const redact = (value) => {
    const text = typeof value === 'string' ? value : '[non-text body]';
    try {
      const walk = (v) => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === 'object') {
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? '[REDACTED]' : walk(x)]));
        }
        return v;
      };
      return JSON.stringify(walk(JSON.parse(text))).slice(0, MAX_BODY);
    } catch {
      return text.slice(0, MAX_BODY).replace(/(pass(?:word|phrase)?|secret|token|key|pin|ssid)=([^&\s"']+)/gi, '$1=[REDACTED]');
    }
  };

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const method = init?.method ?? input?.method ?? 'GET';
    const requestBody = init?.body ? redact(init.body) : undefined;
    return nativeFetch.apply(this, arguments).then((response) => {
      const entry = { kind: 'fetch', method, url, status: response.status, contentType: response.headers.get('content-type'), requestBody };
      response.clone().text().then(
        (text) => push({ ...entry, body: redact(text) }),
        () => push(entry)
      );
      return response;
    });
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__card = { method, url: String(url) };
    return nativeOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const info = this.__card ?? {};
    if (body) info.requestBody = redact(body);
    this.addEventListener('loadend', () => {
      let text = '';
      try {
        text = this.responseType === '' || this.responseType === 'text' ? this.responseText : `[${this.responseType}]`;
      } catch { /* ignore */ }
      push({ kind: 'xhr', ...info, status: this.status, contentType: this.getResponseHeader('content-type'), body: redact(text) });
    });
    return nativeSend.apply(this, arguments);
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    const address = String(url);
    push({ kind: 'ws-open', url: address });
    ws.addEventListener('message', (event) => {
      const data = typeof event.data === 'string' ? redact(event.data) : `[binary ${event.data.byteLength ?? event.data.size} bytes]`;
      push({ kind: 'ws-message', url: address, data });
    });
    ws.addEventListener('close', (event) => push({ kind: 'ws-close', url: address, code: event.code }));
    const nativeWsSend = ws.send.bind(ws);
    ws.send = (data) => {
      push({ kind: 'ws-send', url: address, data: typeof data === 'string' ? redact(data) : '[binary]' });
      return nativeWsSend(data);
    };
    return ws;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    window.EventSource = function (url, config) {
      const source = new NativeEventSource(url, config);
      const address = String(url);
      push({ kind: 'sse-open', url: address });
      source.addEventListener('message', (event) => push({ kind: 'sse-message', url: address, data: redact(event.data) }));
      return source;
    };
    window.EventSource.prototype = NativeEventSource.prototype;
  }

  window.__cardSniffer = { log, dump: () => JSON.stringify(log, null, 2) };
  console.info('Panel sniffer installed. Use the panel, then run: copy(__cardSniffer.dump())');
})();
