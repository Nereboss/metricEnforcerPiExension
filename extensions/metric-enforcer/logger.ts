import type { MetricEnforcerLogLevel } from "./config/types.ts";

const LOG_MESSAGE_PREFIX = "[metric-enforcer]";

export interface MetricEnforcerLoggerContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
  };
}

export function logInfo(
  message: string,
  minimumLevel: MetricEnforcerLogLevel,
  ctx?: MetricEnforcerLoggerContext,
): void {
  log("info", message, minimumLevel, ctx);
}

export function logWarning(
  message: string,
  minimumLevel: MetricEnforcerLogLevel,
  ctx?: MetricEnforcerLoggerContext,
): void {
  log("warning", message, minimumLevel, ctx);
}

export function logError(
  message: string,
  minimumLevel: MetricEnforcerLogLevel,
  ctx?: MetricEnforcerLoggerContext,
): void {
  log("error", message, minimumLevel, ctx);
}

function log(
  level: MetricEnforcerLogLevel,
  message: string,
  minimumLevel: MetricEnforcerLogLevel,
  ctx?: MetricEnforcerLoggerContext,
): void {
  if (getLogLevelPriority(level) < getLogLevelPriority(minimumLevel)) return;

  const prefixedMessage = `${LOG_MESSAGE_PREFIX} ${message}`;

  if (ctx?.hasUI) {
    ctx.ui.notify(prefixedMessage, level);
    return;
  }

  // when PI is in headless mode, directly write logs to console
  if (level === "error") {
    console.error(prefixedMessage);
    return;
  }

  if (level === "warning") {
    console.warn(prefixedMessage);
    return;
  }

  console.info(prefixedMessage);
}

function getLogLevelPriority(level: MetricEnforcerLogLevel): number {
  switch (level) {
    case "info":
      return 1;
    case "warning":
      return 2;
    case "error":
      return 3;
  }
}
