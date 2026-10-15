/**
 * Service worker registration.
 * Registers the root-level /service-worker.js on any secure context
 * (HTTPS or localhost). Updates are applied only after the user agrees.
 */

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.info('Service workers are not supported in this browser.');
    return;
  }

  if (!window.isSecureContext) {
    console.warn('Service worker not registered: HTTPS or localhost is required.');
    return;
  }

  const swUrl = new URL('../service-worker.js', import.meta.url).href;
  const scope = new URL('../', import.meta.url).pathname;
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // Reload once, and only when an existing worker was replaced (not on first install).
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const start = async () => {
    try {
      const registration = await navigator.serviceWorker.register(swUrl, { scope, updateViaCache: 'none' });

      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            promptForUpdate(worker);
          }
        });
      });

      setInterval(() => {
        registration.update().catch(() => {});
      }, 60000);
    } catch (error) {
      console.error('Service worker registration failed:', error);
    }
  };

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
}

function promptForUpdate(worker) {
  const accepted = window.confirm('An app update is available. Reload now to install it?');
  if (accepted) worker.postMessage({ type: 'SKIP_WAITING' });
}

/** Unregister all service workers (useful for debugging). */
export async function unregisterServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const registration of registrations) {
    await registration.unregister();
  }
}
