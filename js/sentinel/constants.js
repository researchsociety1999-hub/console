export const CFG = Object.freeze({
  CARD_ID: 'joker001',
  WATCHDOG_INTERVAL_MS: 15000,
  STREAM_TIMEOUT_MS: 8000,
  TEMP_CRITICAL_C: 22,
  TEMP_EXTREME_C: 35,
  TEMP_LOW_C: 15,
  TEMP_TREND_WINDOW: 6,
  TEMP_TREND_THRESHOLD: 1.5,
  BLE_NOVELTY_RSSI: -75,
  BLE_NOVELTY_WINDOW_MS: 30000,
  ALERT_HISTORY_MAX: 100,
  MIN_TRUST: 0.35,
  LOW_CONFIDENCE: 0.5,
  HORIZONS: [1, 3, 5],
  PREDICT_CONFIDENCE_MIN: 0.6,
  PREDICT_TTC_CYCLES: 3
});

export const STAGES = Object.freeze(['input', 'trust', 'context', 'action']);

export const ACTIONS = Object.freeze({
  MONITOR: { sensitive: false },
  LOG: { sensitive: false },
  FLAG_FOR_REVIEW: { sensitive: false },
  RUN_COOLING_DIAGNOSTIC: { sensitive: false },
  RESTART_MODULE: { sensitive: false },
  SHUTDOWN: { sensitive: true }
});
