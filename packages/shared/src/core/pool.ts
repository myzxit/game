/**
 * Object pooling.
 *
 * The client allocates a lot of short-lived objects per frame (tracers, impact
 * decals, damage numbers, particles). On low-end hardware the resulting GC
 * pauses are visible as stutter, so anything spawned per-shot comes from a pool.
 */

export class ObjectPool<T> {
  private readonly free: T[] = [];
  private liveCount = 0;

  constructor(
    private readonly factory: () => T,
    private readonly reset: (item: T) => void,
    prewarm = 0,
    private readonly maxRetained = 512,
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(factory());
  }

  acquire(): T {
    this.liveCount++;
    const item = this.free.pop();
    return item ?? this.factory();
  }

  release(item: T): void {
    this.liveCount = Math.max(0, this.liveCount - 1);
    this.reset(item);
    // Cap retention so a burst (e.g. an explosion) doesn't permanently bloat RAM.
    if (this.free.length < this.maxRetained) this.free.push(item);
  }

  get stats(): { free: number; live: number } {
    return { free: this.free.length, live: this.liveCount };
  }

  clear(): void {
    this.free.length = 0;
    this.liveCount = 0;
  }
}

/**
 * Fixed-capacity ring buffer.
 * Used for input history (client prediction), server snapshot history
 * (lag compensation), and match event recording (replay groundwork).
 */
export class RingBuffer<T> {
  private readonly items: (T | undefined)[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer capacity must be > 0');
    this.items = new Array<T | undefined>(capacity);
  }

  push(item: T): void {
    this.items[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get length(): number {
    return this.count;
  }

  /** 0 = oldest retained entry. */
  at(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    const start = (this.head - this.count + this.capacity) % this.capacity;
    return this.items[(start + index) % this.capacity];
  }

  newest(): T | undefined {
    return this.count === 0 ? undefined : this.at(this.count - 1);
  }

  oldest(): T | undefined {
    return this.count === 0 ? undefined : this.at(0);
  }

  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const v = this.at(i);
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  /** Find the newest entry satisfying `predicate`, scanning backwards. */
  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = this.count - 1; i >= 0; i--) {
      const v = this.at(i);
      if (v !== undefined && predicate(v)) return v;
    }
    return undefined;
  }

  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
