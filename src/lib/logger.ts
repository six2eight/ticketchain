import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(opts: { level: string; pretty: boolean }): Logger {
  return pino({
    level: opts.level,
    base: undefined,
    transport: opts.pretty
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l" } }
      : undefined,
  });
}

/** A logger that discards everything (tests). */
export const silentLogger = (): Logger => pino({ level: "silent" });
