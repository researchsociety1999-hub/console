// Console state machine: lost -> ghost -> manifested
export const STATES = Object.freeze({
  LOST: "lost",
  GHOST: "ghost",
  MANIFESTED: "manifested"
});

export class ConsoleStateMachine {
  constructor(onChange) {
    this._state = STATES.GHOST;
    this._onChange = onChange || (() => {});
  }

  get state() { return this._state; }

  manifest() {
    this._transition(STATES.MANIFESTED);
  }

  wake() {
    this.manifest();
  }

  enterGhost() {
    if (this._state === STATES.LOST) return;
    this._transition(STATES.GHOST);
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
