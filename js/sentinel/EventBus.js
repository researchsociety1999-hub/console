export class EventBus {
  constructor() { this.handlers = new Map(); }

  on(topic, handler) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic).add(handler);
    return () => this.handlers.get(topic)?.delete(handler);
  }

  emit(topic, payload) {
    for (const handler of [...(this.handlers.get(topic) ?? [])]) {
      try { handler(payload); } catch (error) { console.error(`EventBus handler failed on "${topic}":`, error); }
    }
  }
}
