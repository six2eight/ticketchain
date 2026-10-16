import { errorMessage } from "../lib/errors.js";
import type { Logger } from "../lib/logger.js";

/** Runs `fn` now and then every `intervalMs`, never overlapping itself. */
export class IntervalJob {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    readonly name: string,
    private readonly intervalMs: number,
    private readonly fn: () => Promise<void>,
    private readonly logger: Logger,
  ) {}

  start() {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  async runOnce() {
    if (this.running) return this.running;
    this.running = this.fn()
      .catch((err) => this.logger.error({ job: this.name, err: errorMessage(err) }, "job failed"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
