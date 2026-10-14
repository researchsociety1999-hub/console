import { ACTIONS } from './constants.js';

export class ActionService {
  constructor({ bus, store, telemetry, confirm = async () => false, now = Date.now }) {
    Object.assign(this, { bus, store, telemetry, confirm, now });
  }

  requiresConfirmation(alert) {
    return alert.type === 'POWER_LOSS' || /IMMEDIATE/.test(alert.recommendation ?? '') || Boolean(ACTIONS[alert.action]?.sensitive);
  }

  async sendAction(alert) {
    const fail = (reason) => { this.bus.emit('action:blocked', { alert, reason }); return { ok: false, reason }; };
    try {
      if (!alert) return fail('NO_ALERT');
      if (!(await this.telemetry.detectDevice())) return fail('DEVICE_NOT_DETECTED');
      if (this.store.get().isPoweredOff) return fail('KILL_SWITCH_ENGAGED');
      const sample = this.store.get().lastSample;
      if (!sample || !Number.isFinite(sample.temperatureC)) return fail('INVALID_DATA');
      if (!ACTIONS[alert.action]) return fail('ACTION_NOT_ALLOWED');
      if (this.requiresConfirmation(alert) && (await this.confirm(alert)) !== true) return fail('DENIED_BY_HUMAN');
      alert.state = 'ACKNOWLEDGED';
      alert.timestamp = this.now();
      this.bus.emit('action:executed', { alert, action: alert.action });
      return { ok: true, action: alert.action };
    } catch (error) {
      return fail(`ERROR:${error?.message ?? error}`);
    }
  }
}
