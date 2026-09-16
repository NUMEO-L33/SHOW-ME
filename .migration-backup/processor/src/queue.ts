export type QueueTask = () => Promise<void>;

export class QueueCapacityError extends Error {
  override name = "QueueCapacityError";
}

/**
 * A tiny in-process queue for the Reserved VM. Durable state stays in the
 * repository; this class only limits concurrent ffmpeg processes.
 */
export class ProcessingQueue {
  private readonly waiting: Array<{ key: string; task: QueueTask }> = [];
  private readonly knownKeys = new Set<string>();
  private readonly rerunTasks = new Map<string, QueueTask>();
  private readonly idleWaiters = new Set<() => void>();
  private running = 0;

  constructor(
    private readonly concurrency: number,
    private readonly capacity = 25,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("ProcessingQueue concurrency must be at least 1");
    }
    if (!Number.isInteger(capacity) || capacity < concurrency) {
      throw new Error("ProcessingQueue capacity must be an integer greater than or equal to concurrency");
    }
  }

  enqueue(key: string, task: QueueTask): boolean {
    if (this.knownKeys.has(key)) {
      // A retry can arrive after the worker persisted `failed` but before its
      // finally handler releases the in-memory key. Preserve one rerun so the
      // durable queued state can never be stranded.
      this.rerunTasks.set(key, task);
      return false;
    }
    if (!this.canAcceptNew()) {
      throw new QueueCapacityError(`Processing queue has reached its ${this.capacity}-job capacity.`);
    }
    this.knownKeys.add(key);
    this.waiting.push({ key, task });
    this.drain();
    return true;
  }

  has(key: string) {
    return this.knownKeys.has(key);
  }

  canAcceptNew() {
    return this.knownKeys.size < this.capacity;
  }

  snapshot() {
    return { waiting: this.waiting.length, running: this.running };
  }

  onIdle(): Promise<void> {
    if (this.knownKeys.size === 0) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.add(resolve); });
  }

  private drain() {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) return;
      this.running += 1;
      void next
        .task()
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(JSON.stringify({ event: "queue_task_failed", key: next.key, message }));
        })
        .finally(() => {
          this.running -= 1;
          this.knownKeys.delete(next.key);
          const rerun = this.rerunTasks.get(next.key);
          this.rerunTasks.delete(next.key);
          if (rerun) this.enqueue(next.key, rerun);
          this.drain();
          if (this.knownKeys.size === 0) {
            for (const resolve of this.idleWaiters) resolve();
            this.idleWaiters.clear();
          }
        });
    }
  }
}
