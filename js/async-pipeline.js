export const REASONING_TIMEOUT_MS = 4000;
export const QUEUE_MAX_SIZE = 32;
export const SAFE_ACTIONS = Object.freeze(['MONITOR', 'LOG', 'FLAG_FOR_REVIEW', 'RUN_COOLING_DIAGNOSTIC', 'RESTART_MODULE']);
export const SENSITIVE_ACTIONS = Object.freeze(['EMERGENCY_KILL', 'LOCKDOWN', 'ZEROIZE']);
export const ACTION_ALLOW_LIST = Object.freeze([...SAFE_ACTIONS, ...SENSITIVE_ACTIONS]);
export const SEVERITIES = Object.freeze(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const REASONING_KEYS = ['ai_narrative', 'suggested_severity', 'final_action_type', 'refined_prediction', 'recommendation_text', 'root_cause_summary'];

export class AsyncEventQueue {
  constructor({ maxSize = QUEUE_MAX_SIZE } = {}) {
    this.maxSize = maxSize;
    this.items = [];
    this.handlers = new Set();
    this.dropped = 0;
    this.draining = false;
    this.idle = Promise.resolve();
  }

  subscribe(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  publish(event) {
    if (this.items.length >= this.maxSize) { this.items.shift(); this.dropped += 1; }
    this.items.push(event);
    if (!this.draining) { this.draining = true; this.idle = Promise.resolve().then(() => this.drain()); }
    return this.items.length;
  }

  async drain() {
    try {
      while (this.items.length) {
        const event = this.items.shift();
        for (const handler of [...this.handlers]) {
          try { await handler(event); } catch (error) { console.error('Queue handler failed:', error); }
        }
      }
    } finally { this.draining = false; }
  }

  flush() { return this.idle; }
}

export function generateContextualFeatures(sample = {}, alertHistory = [], options = {}) {
  const criticalTempC = options.criticalTempC ?? 40;
  const temp = Number(sample?.thermal ?? sample?.temperatureC);
  const history = (Array.isArray(alertHistory) ? alertHistory : []).map((e) => Number(e?.thermal ?? e?.temperatureC ?? e?.value)).filter(Number.isFinite);
  const previous = history.length ? history[history.length - 1] : null;
  const delta = Number.isFinite(temp) && previous !== null ? Number((temp - previous).toFixed(2)) : 0;
  const window = [...history.slice(-5), ...(Number.isFinite(temp) ? [temp] : [])];
  const change = window.length > 1 ? window[window.length - 1] - window[0] : 0;
  const trend = change > 1.5 ? 'rising' : change < -1.5 ? 'falling' : 'stable';
  const novelty = Boolean(sample?.ble?.newDeviceId || sample?.rf?.newSignal || (options.knownDeviceIds && sample?.ble?.deviceId && !options.knownDeviceIds.has(sample.ble.deviceId)));
  return { delta_temp: delta, temp_trend: trend, novelty_detected: novelty, critical_threshold_crossed: Number.isFinite(temp) && temp >= criticalTempC };
}

export function buildReasoningPrompt(alert, features, state = {}) {
  const context = { state, alert: { id: alert?.id, type: alert?.type, severity: alert?.severity, sample: alert?.sample ?? null }, features };
  return [
    'You are an advisory analyst for a local-only monitoring console. Your output is a recommendation only.',
    'Reply with ONE JSON object and nothing else, using exactly these string keys: ' + REASONING_KEYS.join(', ') + '.',
    `suggested_severity must be one of ${SEVERITIES.join('|')}. final_action_type must be one of ${ACTION_ALLOW_LIST.join('|')}.`,
    '<context>' + JSON.stringify(context) + '</context>'
  ].join('\n');
}

export function fallbackReasoning(alert = {}, reason = 'Local reasoning unavailable') {
  return {
    ai_narrative: `${reason}; deterministic safeguards remain active.`,
    suggested_severity: SEVERITIES.includes(alert.severity) ? alert.severity : 'LOW',
    final_action_type: 'MONITOR',
    refined_prediction: alert.predictedState ?? 'UNKNOWN',
    recommendation_text: 'Continue deterministic monitoring.',
    root_cause_summary: reason,
    source: 'fallback'
  };
}

export function parseReasoningEnvelope(raw) {
  const text = String(raw ?? '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON object in model output.');
  const parsed = JSON.parse(text.slice(start, end + 1));
  for (const key of REASONING_KEYS) if (typeof parsed[key] !== 'string') throw new Error(`Missing string field: ${key}`);
  const severity = parsed.suggested_severity.toUpperCase();
  if (!SEVERITIES.includes(severity)) throw new Error('Invalid suggested_severity.');
  return { ...Object.fromEntries(REASONING_KEYS.map((k) => [k, parsed[k].slice(0, 600)])), suggested_severity: severity, final_action_type: parsed.final_action_type.toUpperCase(), source: 'llm' };
}

export async function enrichAlertWithLocalReasoning(alert, features, { complete, state = {}, timeoutMs = REASONING_TIMEOUT_MS } = {}) {
  let timer;
  try {
    if (typeof complete !== 'function') return fallbackReasoning(alert, 'Local model not loaded');
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Local reasoning timed out')), timeoutMs); });
    const raw = await Promise.race([Promise.resolve().then(() => complete(buildReasoningPrompt(alert, features, state))), timeout]);
    return parseReasoningEnvelope(raw);
  } catch (error) {
    return fallbackReasoning(alert, error?.message || 'Local reasoning failed');
  } finally { clearTimeout(timer); }
}

export function extractCompletionText(result) {
  if (typeof result === 'string') return result;
  const choice = result?.choices?.[0];
  return choice?.text ?? choice?.message?.content ?? '';
}

export function createWllamaCompleter(localLLM) {
  if (!localLLM?.loaded || typeof localLLM.wllama?.createCompletion !== 'function') return null;
  return async (prompt) => extractCompletionText(await localLLM.wllama.createCompletion({ prompt, max_tokens: 256, temperature: 0.2 }));
}

export async function dispatchOnlyAllowedRecommendation(alert, reasoning, deps = {}) {
  const { validatePacket, isAuthorized, requestConfirmation, execute, audit } = deps;
  const action = String(reasoning?.final_action_type ?? '').toUpperCase();
  const record = async (status, extra = {}) => { try { await audit?.(`RECOMMENDATION_${status}`, { alertId: alert?.id, action, ...extra }); } catch { /* audit must not break dispatch */ } return { status, action, ...extra }; };
  try {
    if (!ACTION_ALLOW_LIST.includes(action)) return await record('BLOCKED_NOT_ALLOWLISTED');
    if (typeof isAuthorized !== 'function' || !isAuthorized()) return await record('BLOCKED_UNAUTHORIZED');
    if (typeof validatePacket !== 'function' || !validatePacket(alert)) return await record('BLOCKED_INVALID_PACKET');
    if (SENSITIVE_ACTIONS.includes(action)) {
      if (typeof requestConfirmation !== 'function') return await record('CONFIRMATION_REQUIRED');
      const approved = await requestConfirmation({ action, alert, reasoning });
      if (approved !== true) return await record('DENIED_BY_HUMAN');
    }
    if (typeof execute !== 'function') return await record('NO_EXECUTOR');
    const result = await execute(action, alert);
    return await record('EXECUTED', { result });
  } catch (error) {
    return await record('FAILED', { error: error?.message });
  }
}

export function createMonitoringPipeline({ publishTelemetry, publishAlert, publishReasoning, detectAlert, complete, getCompleter, state = () => ({}), dispatchDeps = {}, queue = new AsyncEventQueue() } = {}) {
  const history = [];
  queue.subscribe((sample) => {
    const features = generateContextualFeatures(sample, history);
    history.push(sample); if (history.length > 100) history.shift();
    publishTelemetry?.({ sample, features });
    const alert = detectAlert?.(sample, features);
    if (!alert) return;
    publishAlert?.(alert);
    void enrichAlertWithLocalReasoning(alert, features, { complete: getCompleter ? getCompleter() : complete, state: state() })
      .then(async (reasoning) => {
        publishReasoning?.({ alert, reasoning });
        await dispatchOnlyAllowedRecommendation(alert, reasoning, dispatchDeps);
      })
      .catch((error) => console.error('Reasoning pipeline failed:', error));
  });
  return { queue, sampleIn: (sample) => queue.publish(sample), history };
}
