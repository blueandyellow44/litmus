import { env } from "./env.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const threshold = levels[env.LOG_LEVEL];

function log(level: keyof typeof levels, msg: string, data?: Record<string, unknown>) {
  if (levels[level] < threshold) return;
  const entry = { t: new Date().toISOString(), level, msg, ...data };
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(JSON.stringify(entry) + "\n");
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};
