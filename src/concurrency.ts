/**
 * 信号量：控制同时运行的 CLI 子进程数量。
 * 超出 max 的请求排队等待；队列超出 maxQueued 则直接拒绝。
 */
export class Semaphore {
  private current = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly max: number,
    private readonly maxQueued: number,
  ) {}

  acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueued) {
      return Promise.reject(new QueueFullError(this.queue.length, this.maxQueued));
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  get active(): number {
    return this.current;
  }

  get pending(): number {
    return this.queue.length;
  }
}

export class QueueFullError extends Error {
  constructor(
    public readonly queueLength: number,
    public readonly maxQueued: number,
  ) {
    super(
      `Too many concurrent requests: ${queueLength} queued (max ${maxQueued})`,
    );
    this.name = "QueueFullError";
  }
}
