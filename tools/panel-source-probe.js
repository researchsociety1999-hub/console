/**
 * Panel source probe (read-only). Paste into the browser DevTools console while the card's own
 * web panel is open (for example the page at the card's address). It fetches the panel's page
 * and the scripts it loads from the same address, and lists the lines that mention WebSocket,
 * fetch, XMLHttpRequest, message handling or URL paths. The panel's own code is the best
 * evidence of the real WebSocket URL and message format.
 *
 * It only reads files the panel already serves. Afterwards run:  copy(__cardProbe.text)
 * Lines that look like they contain credentials are redacted; review before sharing anyway.
 * Alternative without code: DevTools > Sources, or right-click the page > View page source.
 */
(async () => {
  const MAX_ENTRIES = 600;
  const interesting = /(new\s+WebSocket|WebSocket\(|EventSource\(|fetch\(|XMLHttpRequest|\.open\(\s*["'](?:GET|POST)|wss?:\/\/|onmessage|addEventListener\(\s*["']message|JSON\.parse|binaryType|\.send\(|["']\/[A-Za-z0-9_\-\/\.]{1,40}["'])/;
  const secret = /((?:pass(?:word|phrase)?|secret|token|key|pin)\s*[:=]\s*)["'][^"']+["']/gi;

  const grab = async (url) => {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  };

  const sources = [{ url: `${location.href} (page markup and inline scripts)`, text: document.documentElement.outerHTML }];
  const scriptUrls = [...document.querySelectorAll('script[src]')]
    .map((el) => new URL(el.src, location.href).href)
    .filter((url) => url.startsWith(location.origin));
  for (const url of scriptUrls) {
    const text = await grab(url);
    if (text) sources.push({ url, text });
  }

  const report = [];
  const add = (url, lineNumber, snippet) => {
    if (report.length < MAX_ENTRIES) report.push(`${url}:${lineNumber}: ${snippet.replace(secret, '$1[REDACTED]')}`);
  };
  const global = new RegExp(interesting.source, 'g');
  for (const { url, text } of sources) {
    text.split(/\r?\n/).forEach((line, index) => {
      if (line.length <= 300) {
        if (interesting.test(line)) add(url, index + 1, line.trim());
      } else {
        for (const match of line.matchAll(global)) {
          add(url, index + 1, line.slice(Math.max(0, match.index - 100), match.index + 160).trim());
        }
      }
    });
  }

  window.__cardProbe = { sources: sources.map((s) => s.url), entries: report.length, text: report.join('\n') };
  console.info(`Probe read ${sources.length} source(s) and found ${report.length} relevant line(s). Run: copy(__cardProbe.text)`);
})();
