/**
 * Responsive Layout Manager
 * Dynamically adapts UI layout based on viewport size and orientation
 */

const MOBILE_BREAKPOINT = 640;
const TABLET_BREAKPOINT = 980;

function getViewportMode() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;

  if (width <= MOBILE_BREAKPOINT) {
    return height > width ? 'mobile-portrait' : 'mobile-landscape';
  }

  if (width <= TABLET_BREAKPOINT) {
    return height > width ? 'tablet-portrait' : 'tablet-landscape';
  }

  return 'desktop';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function resizeCanvas(canvas) {
  if (!canvas) return;

  const parent = canvas.parentElement;
  if (!parent) return;

  const dpr = window.devicePixelRatio || 1;
  const parentWidth = parent.clientWidth;
  const parentHeight = parent.clientHeight;

  const maxDimension = Math.min(parentWidth, parentHeight) * 0.9;
  const targetSize = clamp(maxDimension, 120, 260);

  canvas.style.width = `${targetSize}px`;
  canvas.style.height = `${targetSize}px`;

  canvas.width = Math.round(targetSize * dpr);
  canvas.height = Math.round(targetSize * dpr);

  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  canvas.dispatchEvent(
    new CustomEvent('canvas-resized', {
      detail: { size: targetSize, dpr, mode: getViewportMode() }
    })
  );
}

function applyLayout() {
  const mode = getViewportMode();
  document.body.dataset.viewport = mode;

  const app = document.querySelector('#app');
  const viewport = document.querySelector('#aegis-viewport');

  if (!app || !viewport) return;

  if (mode === 'mobile-portrait') {
    app.style.height = '100dvh';
    app.style.padding = '0.4rem';
    viewport.style.gridTemplateColumns = '1fr';
    viewport.style.gridTemplateRows = 'auto';
    viewport.style.gridTemplateAreas = `
      "thermal"
      "alerts"
      "network"
      "nfc"
      "device"
      "fleet"
      "audit"
    `;
  } else if (mode === 'mobile-landscape') {
    app.style.height = '100dvh';
    app.style.padding = '0.3rem';
    viewport.style.gridTemplateColumns = '1fr 1fr';
    viewport.style.gridTemplateRows = 'auto';
    viewport.style.gridTemplateAreas = `
      "thermal network"
      "alerts nfc"
      "device fleet"
      "audit audit"
    `;
  } else if (mode === 'tablet-portrait') {
    app.style.height = '100dvh';
    app.style.padding = '0.5rem';
    viewport.style.gridTemplateColumns = '1fr 1fr';
    viewport.style.gridTemplateRows = 'auto';
    viewport.style.gridTemplateAreas = `
      "thermal alerts"
      "network nfc"
      "device fleet"
      "audit audit"
    `;
  } else if (mode === 'tablet-landscape') {
    app.style.height = '100dvh';
    app.style.padding = '0.6rem';
    viewport.style.gridTemplateColumns = '1fr 1fr 1fr';
    viewport.style.gridTemplateRows = 'auto auto';
    viewport.style.gridTemplateAreas = `
      "thermal alerts network"
      "nfc device fleet"
      "audit audit audit"
    `;
  } else {
    app.style.height = '100vh';
    app.style.padding = '0.6rem';
    viewport.style.gridTemplateColumns = '1fr 1fr 1fr 0.95fr';
    viewport.style.gridTemplateRows = '1fr 1fr';
    viewport.style.gridTemplateAreas = `
      "thermal alerts network audit"
      "nfc device fleet audit"
    `;
  }

  const thermalCanvas = document.getElementById('thermal-display');
  const radarCanvas = document.getElementById('radar-display');

  resizeCanvas(thermalCanvas);
  resizeCanvas(radarCanvas);
}

let resizeTimer = null;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyLayout, 80);
});

window.addEventListener('orientationchange', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(applyLayout, 150);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', applyLayout);
} else {
  applyLayout();
}

// Export for testing
export { getViewportMode, resizeCanvas };