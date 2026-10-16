export type Clock = () => number; // epoch milliseconds

export const systemClock: Clock = () => Date.now();

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export const unixSeconds = (ms: number) => Math.floor(ms / 1000);
