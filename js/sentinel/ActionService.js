import { ACTIONS } from './constants.js';

// Actions that only change local dashboard state and never need the card.
const LOCAL_ONLY_ACTIONS = new Set(['MONITOR', 'LOG', 'FLAG_FOR_REVIEW']);

export class ActionService {
  /**
   * commandBridge(action, alert) must send the command to the real card and resolve
   * { acknowledged: true } only when the card acknowledged it. Without a bridge, any action that
   * would need the card fails with NO_CARD_COMMAND_CAPABILITY instead of pretending to succeed.
   */
  constructor({ bus, store, telemetry, confirm = async () => false, commandBridge = null, now = Date.now }) {
    Object.assign(this, { bus, store, telemetry, confirm, commandBridge, now });
  }

  requiresConfirmation(alert) {
    return alert.type === 'POWER_LOSS' || /IMMEDIATE/.test(alert.recommendation ?? '') || Boolean(ACTIONS[alert.action]?.sensitive);
  }

  async dispatch(alert) {
    if (LOCAL_ONLY_ACTIONS.has(alert.action)) return { local: true, acknowledgedByCard: false };
    if (typeof this.commandBridge !== 'function') {
      return { local: false, acknowledgedByCard: false, reason: 'NO_CARD_COMMAND_CAPABILITY' };
    }
    const ack = await this.commandBridge(alert.action, alert);
    const acknowledged = ack?.acknowledged === true;
    return { local: false, acknowledgedByCard: acknowledged, reason: acknowledged ? undefined : 'CARD_DID_NOT_ACKNOWLEDGE' };
  }

  async sendAction(alert) {
    const fail = (reason) => { this.bus.emit('action:blocked', { alert, reason }); return { ok: false, reason }; };
    try {
      if (!alert) return fail('NO_ALERT');
      if (!(await this.telemetry.detectDevice())) return fail('DEVICE_NOT_DETECTED');
      if (this.store.get().isPoweredOff) return fail('KILL_SWITCH_ENGAGED');
      const sample = this.store.get().lastSample;
      if (!sample || sample.isPresent === false) return fail('INVALID_DATA');
      if (!ACTIONS[alert.action]) return fail('ACTION_NOT_ALLOWED');
      if (this.requiresConfirmation(alert) && (await this.confirm(alert)) !== true) return fail('DENIED_BY_HUMAN');
      const outcome = await this.dispatch(alert);
      if (!outcome.local && !outcome.acknowledgedByCard) return fail(outcome.reason);
      alert.state = 'ACKNOWLEDGED';
      alert.timestamp = this.now();
      alert.commandResult = outcome;
      this.bus.emit('action:executed', { alert, action: alert.action });
      return { ok: true, action: alert.action, sentToCard: !outcome.local };
    } catch (error) {
      return fail(`ERROR:${error?.message ?? error}`);
    }
  }
}
