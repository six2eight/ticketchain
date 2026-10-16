import { sleep } from "./time.js";

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/** Exponential backoff with full jitter: random(0, min(max, base * 2^attempt)). */
export function backoffDelay(
  attempt: number,
  { baseMs = 250, maxMs = 30_000 }: BackoffOptions = {},
) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * ceiling);
}

export interface RetryOptions extends BackoffOptions {
  retries?: number;
  shouldRetry?: (err: unknown) => boolean;
}

export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const { retries = 3, shouldRetry = () => true } = opts;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !shouldRetry(err)) throw err;
      await sleep(backoffDelay(attempt, opts));
    }
  }
}
