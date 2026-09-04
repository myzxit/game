/**
 * Typed event bus. Used for cross-system decoupling (combat -> quests,
 * quests -> notifications, match -> analytics) without circular imports.
 */

export type Listener<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<Listener<never>>>();

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    const dispose = this.on(event, (payload) => {
      dispose();
      listener(payload);
    });
    return dispose;
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy so a listener that unsubscribes mid-dispatch can't corrupt iteration.
    for (const listener of Array.from(set)) {
      try {
        (listener as Listener<Events[K]>)(payload);
      } catch (e) {
        // One broken subscriber must not stop the rest of the game reacting.
        console.error('[EventBus] listener threw', event, e);
      }
    }
  }

  listenerCount<K extends keyof Events>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}
