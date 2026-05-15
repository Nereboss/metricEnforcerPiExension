import type { MetricRule } from "../types.ts";
import type { AnalyzerConfig, BackpressureConfig, MetricEnforcerConfig, MetricEnforcerLogLevel } from "./types.ts";

type JsonObject = Record<string, unknown>;

export interface ValidatedMetricEnforcerConfig {
  config: MetricEnforcerConfig;
  warnings: string[];
}

export function validateMetricEnforcerConfig(value: unknown, sourcePath: string): ValidatedMetricEnforcerConfig {
  const root = expectObject(value, `Config at ${sourcePath}`);
  const warnings: string[] = [];

  return {
    config: {
      logLevel: validateLogLevel(root.logLevel, sourcePath, warnings),
      analyzers: validateAnalyzers(root.analyzers, sourcePath),
      thresholds: validateThresholds(root.thresholds, sourcePath),
      backpressure: validateBackpressure(root.backpressure, sourcePath, warnings),
      metricDefinitions: validateMetricDefinitions(root.metricDefinitions, sourcePath),
    },
    warnings,
  };
}

function validateLogLevel(value: unknown, sourcePath: string, warnings: string[]): MetricEnforcerLogLevel {
  if (value === undefined) {
    return "warning";
  }

  if (value === "info" || value === "warning" || value === "error") {
    return value;
  }

  warnings.push(
    `Invalid "logLevel" in ${sourcePath}: expected one of "info", "warning", "error". Falling back to "warning".`,
  );
  return "warning";
}

function validateAnalyzers(value: unknown, sourcePath: string): Record<string, AnalyzerConfig> {
  const analyzers = expectObject(value, `"analyzers" in ${sourcePath}`);
  const entries = Object.entries(analyzers);

  if (entries.length === 0) {
    throw new Error(`[metric-enforcer] "analyzers" in ${sourcePath} must define at least one analyzer.`);
  }

  return Object.fromEntries(entries.map(([name, config]) => [name, validateAnalyzerConfig(name, config, sourcePath)]));
}

function validateAnalyzerConfig(name: string, value: unknown, sourcePath: string): AnalyzerConfig {
  const context = `Analyzer "${name}" in ${sourcePath}`;
  const analyzer = expectObject(value, context);

  return {
    enabled: expectRequiredBoolean(analyzer, "enabled", context),
    command: expectOptionalString(analyzer, "command", context),
    args: expectOptionalStringArray(analyzer, "args", context),
  };
}

function validateThresholds(value: unknown, sourcePath: string): MetricEnforcerConfig["thresholds"] {
  const thresholds = expectObject(value, `"thresholds" in ${sourcePath}`);

  return {
    global: validateMetricRulesMap(thresholds.global, `${sourcePath} -> thresholds.global`),
    filePatterns:
      thresholds.filePatterns === undefined
        ? {}
        : validateFilePatternRulesMap(thresholds.filePatterns, `${sourcePath} -> thresholds.filePatterns`),
  };
}

function validateBackpressure(value: unknown, sourcePath: string, warnings: string[]): BackpressureConfig {
  if (value === undefined) {
    return {
      errorOnly: false,
      maxBackpressureRetries: 3,
    };
  }

  const backpressure = expectObject(value, `"backpressure" in ${sourcePath}`);

  return {
    errorOnly: expectOptionalBoolean(backpressure, "errorOnly", `"backpressure" in ${sourcePath}`) ?? false,
    maxBackpressureRetries: validateMaxBackpressureRetries(backpressure.maxBackpressureRetries, sourcePath, warnings),
  };
}

function validateMaxBackpressureRetries(value: unknown, sourcePath: string, warnings: string[]): number {
  if (value === undefined) {
    return 3;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < -1) {
    warnings.push(
      `Invalid "backpressure.maxBackpressureRetries" in ${sourcePath}: expected an integer >= -1. Falling back to 3.`,
    );
    return 3;
  }

  return value;
}

function validateMetricDefinitions(value: unknown, sourcePath: string): Record<string, string> {
  if (value === undefined) return {};

  const definitions = expectObject(value, `"metricDefinitions" in ${sourcePath}`);

  return Object.fromEntries(
    Object.entries(definitions).map(([metricName, definition]) => {
      if (metricName.trim().length === 0) {
        throw new Error(`[metric-enforcer] "metricDefinitions" in ${sourcePath} must not contain empty metric names.`);
      }

      if (typeof definition !== "string") {
        throw new Error(
          `[metric-enforcer] "metricDefinitions" in ${sourcePath}["${metricName}"] must be a string.`,
        );
      }

      return [metricName, definition];
    }),
  );
}

function validateFilePatternRulesMap(value: unknown, context: string): Record<string, Record<string, MetricRule>> {
  const patterns = expectObject(value, context);

  return Object.fromEntries(
    Object.entries(patterns).map(([pattern, metricRules]) => {
      if (pattern.trim().length === 0) {
        throw new Error(`[metric-enforcer] ${context} must not contain empty file-pattern keys.`);
      }

      return [pattern, validateMetricRulesMap(metricRules, `${context}["${pattern}"]`)];
    }),
  );
}

function validateMetricRulesMap(value: unknown, context: string): Record<string, MetricRule> {
  const rules = expectObject(value, context);

  return Object.fromEntries(
    Object.entries(rules).map(([metricName, metricRule]) => {
      if (metricName.trim().length === 0) {
        throw new Error(`[metric-enforcer] ${context} must not contain empty metric names.`);
      }

      return [metricName, validateMetricRule(metricRule, `${context}["${metricName}"]`)];
    }),
  );
}

function validateMetricRule(value: unknown, context: string): MetricRule {
  const rule = expectObject(value, `${context} (metric rule)`);
  const warning = expectOptionalFiniteNumber(rule, "warning", context);
  const error = expectOptionalFiniteNumber(rule, "error", context);

  if (warning === undefined && error === undefined) {
    throw new Error(`[metric-enforcer] ${context} must define at least one of "warning" or "error".`);
  }

  return { warning, error };
}

function expectObject(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`[metric-enforcer] ${context} must be an object.`);
  }

  return value;
}

function expectRequiredBoolean(object: JsonObject, key: string, context: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") {
    throw new Error(`[metric-enforcer] ${context} must define boolean "${key}".`);
  }

  return value;
}

function expectOptionalBoolean(object: JsonObject, key: string, context: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`[metric-enforcer] ${context} must define boolean "${key}" when present.`);
  }

  return value;
}

function expectOptionalString(object: JsonObject, key: string, context: string): string | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`[metric-enforcer] ${context} must define string "${key}" when present.`);
  }

  return value;
}

function expectOptionalStringArray(object: JsonObject, key: string, context: string): string[] | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`[metric-enforcer] ${context} must define string[] "${key}" when present.`);
  }

  return value;
}

function expectOptionalFiniteNumber(object: JsonObject, key: string, context: string): number | undefined {
  const value = object[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[metric-enforcer] ${context}.${key} must be a finite number when present.`);
  }

  return value;
}
