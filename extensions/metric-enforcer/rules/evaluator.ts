import type { ThresholdConfig } from "../config/types.js";
import type { AnalyzerResult, MetricRule, ResolvedThresholds, Violation } from "../types.js";

interface CompiledFilePatternRule {
  pattern: string;
  regex: RegExp;
  metrics: Record<string, MetricRule>;
}

export function evaluateAnalyzerResults(
  analyzerResults: readonly AnalyzerResult[],
  thresholds: ThresholdConfig,
): Violation[] {
  const compiledFilePatternRules = compileFilePatternRules(thresholds.filePatterns);
  const resolvedThresholdsByFilePath = new Map<string, ResolvedThresholds>();

  return analyzerResults.flatMap((analyzerResult) =>
    analyzerResult.files.flatMap((fileMetrics) => {
      const resolvedThresholds = getOrResolveThresholds(
        fileMetrics.filePath,
        thresholds.global,
        compiledFilePatternRules,
        resolvedThresholdsByFilePath,
      );

      return Object.entries(fileMetrics.metrics)
        .map(([metricName, actual]) => evaluateMetricRule(fileMetrics.filePath, metricName, actual, resolvedThresholds.metrics[metricName]))
        .filter((violation): violation is Violation => violation !== undefined);
    }),
  );
}

export function resolveThresholdsForFile(filePath: string, thresholds: ThresholdConfig): ResolvedThresholds {
  const compiledFilePatternRules = compileFilePatternRules(thresholds.filePatterns);
  return resolveThresholdsForFileWithCompiledRules(filePath, thresholds.global, compiledFilePatternRules);
}

function getOrResolveThresholds(
  filePath: string,
  globalRules: Record<string, MetricRule>,
  compiledFilePatternRules: readonly CompiledFilePatternRule[],
  cache: Map<string, ResolvedThresholds>,
): ResolvedThresholds {
  const cached = cache.get(filePath);
  if (cached !== undefined) return cached;

  const resolved = resolveThresholdsForFileWithCompiledRules(filePath, globalRules, compiledFilePatternRules);
  cache.set(filePath, resolved);
  return resolved;
}

function resolveThresholdsForFileWithCompiledRules(
  filePath: string,
  globalRules: Record<string, MetricRule>,
  compiledFilePatternRules: readonly CompiledFilePatternRule[],
): ResolvedThresholds {
  const resolvedMetrics = resolveMetricRules(globalRules);

  for (const filePatternRule of compiledFilePatternRules) {
    if (!filePatternRule.regex.test(filePath)) {
      continue;
    }

    for (const [metricName, overrideRule] of Object.entries(filePatternRule.metrics)) {
      const currentRule = resolvedMetrics[metricName];

      resolvedMetrics[metricName] = {
        warning:
          overrideRule.warning === undefined ? currentRule?.warning : normalizeThresholdValue(overrideRule.warning),
        error:
          overrideRule.error === undefined ? currentRule?.error : normalizeThresholdValue(overrideRule.error),
      };
    }
  }

  return {
    filePath,
    metrics: resolvedMetrics,
  };
}

function evaluateMetricRule(
  filePath: string,
  metric: string,
  actual: number,
  rule: MetricRule | undefined,
): Violation | undefined {
  if (rule === undefined) {
    return undefined;
  }

  if (rule.error !== undefined && actual > rule.error) {
    return {
      filePath,
      metric,
      actual,
      threshold: rule.error,
      severity: "error",
    };
  }

  if (rule.warning !== undefined && actual > rule.warning) {
    return {
      filePath,
      metric,
      actual,
      threshold: rule.warning,
      severity: "warning",
    };
  }

  return undefined;
}

function resolveMetricRules(metricRules: Record<string, MetricRule>): Record<string, MetricRule> {
  return Object.fromEntries(
    Object.entries(metricRules).map(([metricName, rule]) => [
      metricName,
      {
        warning: normalizeThresholdValue(rule.warning),
        error: normalizeThresholdValue(rule.error),
      },
    ]),
  );
}

function normalizeThresholdValue(value: number | undefined): number | undefined {
  return value === -1 ? undefined : value;
}

function compileFilePatternRules(
  filePatternRules: Record<string, Record<string, MetricRule>>,
): CompiledFilePatternRule[] {
  return Object.entries(filePatternRules)
    .map(([pattern, metrics]) => ({
      pattern,
      regex: globToRegExp(pattern),
      metrics,
    }))
    .sort(comparePatternSpecificity);
}

function comparePatternSpecificity(a: CompiledFilePatternRule, b: CompiledFilePatternRule): number {
  const aWildcardCount = countWildcards(a.pattern);
  const bWildcardCount = countWildcards(b.pattern);

  if (aWildcardCount !== bWildcardCount) {
    return bWildcardCount - aWildcardCount;
  }

  if (a.pattern.length !== b.pattern.length) {
    return a.pattern.length - b.pattern.length;
  }

  return a.pattern.localeCompare(b.pattern);
}

function countWildcards(pattern: string): number {
  return [...pattern].filter((character) => character === "*").length;
}

function globToRegExp(pattern: string): RegExp {
  const escapedPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");

  return new RegExp(`^${escapedPattern}$`);
}
