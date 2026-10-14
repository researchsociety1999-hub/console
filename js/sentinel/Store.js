export class Store {
  constructor(bus, initial = {}) {
    this.bus = bus;
    this.state = { cardState: 'lost', lastSample: null, lastAlert: null, alertHistory: [], isPoweredOff: false, context: null, ...initial };
  }

  get() { return this.state; }

  patch(partial) {
    this.state = { ...this.state, ...partial };
    this.bus.emit('state:changed', this.state);
    return this.state;
  }
}
