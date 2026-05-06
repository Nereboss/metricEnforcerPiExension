import type { MetricRule } from "../types.ts";
import type { AnalyzerConfig, MetricEnforcerConfig } from "./types.ts";

type JsonObject = Record<string, unknown>;

export function validateMetricEnforcerConfig(value: unknown, sourcePath: string): MetricEnforcerConfig {
  const root = expectObject(value, `Config at ${sourcePath}`);

  return {
    analyzers: validateAnalyzers(root.analyzers, sourcePath),
    thresholds: validateThresholds(root.thresholds, sourcePath),
  };
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
