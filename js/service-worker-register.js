/**
 * Service Worker Registration
 * Safe registration for private/local-only access
 */

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.log('Service Workers not supported');
    return;
  }

  const isPrivateHost =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]' ||
    /^192\.168\./.test(location.hostname) ||
    /^10\./.test(location.hostname) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(location.hostname) ||
    location.hostname.endsWith('.local');

  const isSecureContext = location.protocol === 'https:' || location.hostname === 'localhost';

  if (!isPrivateHost || !isSecureContext) {
    console.warn(
      'Service Worker registration skipped. This app requires HTTPS or localhost for PWA features.'
    );
    return;
  }

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/js/service-worker.js', {
        scope: '/',
        updateViaCache: 'none'
      });

      console.log('Service Worker registered:', registration);

      // Handle updates
      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            console.log('New Service Worker available. App update ready.');
            // Prompt user to reload (optional)
            showUpdatePrompt(registration);
          }
        });
      });

      // Periodically check for updates
      setInterval(() => {
        registration.update();
      }, 60000); // Check every minute
    } catch (error) {
      console.error('Service Worker registration failed:', error);
    }
  });
}

/**
 * Show update prompt to user
 */
function showUpdatePrompt(registration) {
  const confirmUpdate = confirm(
    'App update available. Reload now to install the latest version?'
  );
  if (confirmUpdate) {
    const newWorker = registration.waiting;
    if (newWorker) {
      newWorker.postMessage({ type: 'SKIP_WAITING' });
      window.location.reload();
    }
  }
}

/**
 * Unregister all service workers (useful for debugging)
 */
export async function unregisterServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;

  const registrations = await navigator.serviceWorker.getRegistrations();
  for (const registration of registrations) {
    await registration.unregister();
  }
  console.log('All Service Workers unregistered');
}
