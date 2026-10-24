/**
 * WebSocket frame recorder (read-only). Paste into the browser DevTools console of the card's
 * own web panel page, then run:
 *   recordCardFrames('ws://<card address>/<path from DevTools > Network > WS>')
 * It opens ONE extra WebSocket, records up to 30 frames (or 30 s), then closes it. It sends
 * nothing unless you pass messages in { send: [...] } that you saw the panel itself send.
 * Afterwards run:  copy(__cardFrames.dump())
 * MAC addresses become [MAC] and credential-like values are redacted. Review before sharing.
 * The card has very little free memory, so keep recordings short.
 */
window.recordCardFrames = (url, { maxFrames = 30, maxMs = 30000, send = [] } = {}) => new Promise((resolve) => {
  const MAC = /\b(?:[0-9A-F]{2}:){5}[0-9A-F]{2}\b/gi;
  const SECRET = /("?(?:pass(?:word|phrase)?|secret|token|key|pin|ssid)"?\s*[:=]\s*)("[^"]*"|[^,\s}&]+)/gi;
  const redact = (text) => text.replace(MAC, '[MAC]').replace(SECRET, '$1"[REDACTED]"').slice(0, 400);
  const frames = [];
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  const opened = Date.now();
  let done = false;

  const finish = (reason) => {
    if (done) return;
    done = true;
    try { ws.close(); } catch { /* ignore */ }
    const out = { url, reason, count: frames.length, frames };
    window.__cardFrames = { ...out, dump: () => JSON.stringify(out, null, 2) };
    console.info(`Recorded ${frames.length} frame(s) (${reason}). Run: copy(__cardFrames.dump())`);
    resolve(out);
  };

  ws.onopen = () => { for (const message of send) ws.send(message); };
  ws.onerror = () => finish('error');
  ws.onclose = () => finish('closed');
  ws.onmessage = (event) => {
    const t = Date.now() - opened;
    if (typeof event.data === 'string') {
      let keys;
      try {
        const parsed = JSON.parse(event.data);
        keys = parsed && typeof parsed === 'object' ? Object.keys(parsed) : undefined;
      } catch { /* not JSON */ }
      frames.push({ t, kind: 'text', chars: event.data.length, json: keys !== undefined, keys, preview: redact(event.data) });
    } else {
      const bytes = new Uint8Array(event.data);
      frames.push({ t, kind: 'binary', bytes: bytes.length, hex: Array.from(bytes.slice(0, 64), (b) => b.toString(16).padStart(2, '0')).join(' ') });
    }
    if (frames.length >= maxFrames) finish('max frames');
  };
  setTimeout(() => finish('time limit'), maxMs);
});
console.info("Use: recordCardFrames('ws://<card address>/<path>')");
