// src/utils/logger.ts

type LogFn = (scope: string, ...args: unknown[]) => void;

function makeLogFn(level: "info" | "warn" | "error"): LogFn {
  return (scope: string, ...args: unknown[]) => {
    const prefix = `[reckless:${scope}]`;
    if (level === "info") console.log(prefix, ...args);
    else if (level === "warn") console.warn(prefix, ...args);
    else console.error(prefix, ...args);
  };
}

export const log = {
  info: makeLogFn("info"),
  warn: makeLogFn("warn"),
  error: makeLogFn("error"),
};
