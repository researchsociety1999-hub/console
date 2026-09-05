// Console state machine: lost -> ghost -> manifested
export const STATES = Object.freeze({
  LOST: "lost",
  GHOST: "ghost",
  MANIFESTED: "manifested"
});

export class ConsoleStateMachine {
  constructor(onChange) {
    this._state = STATES.LOST;
    this._onChange = onChange || (() => {});
  }

  get state() { return this._state; }

  manifest() {
    this._transition(STATES.MANIFESTED);
  }

  enterGhost() {
    if (this._state === STATES.LOST) return this.manifest();
    this._transition(this._state === STATES.GHOST ? STATES.MANIFESTED : STATES.GHOST);
  }

  sever() {
    this._transition(STATES.LOST);
  }

  _transition(next) {
    if (next === this._state) return;
    const prev = this._state;
    this._state = next;
    this._onChange(next, prev);
  }
}
