import type { MetricEnforcerConfig } from "./config/types.ts";
import type { AnalyzerResult, Violation } from "./types.ts";
import type { AnalyzerPlugin } from "./analyzers/analyzer-plugin.ts";
import { ccshAnalyzerPlugin, type CcshAnalyzerContext } from "./analyzers/ccsh-analyzer.ts";
import { evaluateAnalyzerResults } from "./rules/evaluator.ts";
import { getErrorCode } from "./utils.ts";

interface MetricAnalyzerExecution {
  selectedFiles: string[];
  result?: AnalyzerResult;
  warning?: string;
}

const analyzerPlugins: AnalyzerPlugin<MetricEnforcerConfig, CcshAnalyzerContext>[] = [ccshAnalyzerPlugin];

export interface CollectedMetricDefinitions {
  definitions: Record<string, string>;
  warnings: string[];
}

/**
 * Gathers metric definitions from the enabled analyzers so the system-prompt policy only describes
 * metrics that can actually appear this run. The analyzer that emits a metric owns its definition;
 * config.metricDefinitions is layered on top as a per-key override. Conflicting definitions between
 * two enabled analyzers are surfaced as warnings rather than resolved silently.
 */
export function collectMetricDefinitions(config: MetricEnforcerConfig): CollectedMetricDefinitions {
  const enabledPlugins = analyzerPlugins.filter((plugin) => plugin.isEnabled(config));
  const definitions: Record<string, string> = {};
  const definingPluginByMetric = new Map<string, string>();
  const warnings: string[] = [];

  for (const plugin of enabledPlugins) {
    for (const [metric, definition] of Object.entries(plugin.metricDefinitions)) {
      const previousPlugin = definingPluginByMetric.get(metric);

      if (previousPlugin !== undefined && definitions[metric] !== definition) {
        warnings.push(
          `Metric "${metric}" is defined by analyzers "${previousPlugin}" and "${plugin.name}" with conflicting definitions. Using the one from "${plugin.name}".`,
        );
      }

      definitions[metric] = definition;
      definingPluginByMetric.set(metric, plugin.name);
    }
  }

  // Project config overrides analyzer-provided definitions for the same metric name.
  for (const [metric, definition] of Object.entries(config.metricDefinitions)) {
    definitions[metric] = definition;
  }

  return { definitions, warnings };
}

export interface OrchestrationResult {
  enabledAnalyzers: string[];
  analyzedFiles: string[];
  analyzerResults: AnalyzerResult[];
  analyzerWarnings: string[];
  violations: Violation[];
}

export async function runMetricOrchestration(
  touchedFiles: readonly string[],
  config: MetricEnforcerConfig,
  ctx: CcshAnalyzerContext,
): Promise<OrchestrationResult> {
  const enabledPlugins = analyzerPlugins.filter((plugin) => plugin.isEnabled(config));
  const executions = await Promise.all(
    enabledPlugins.map((plugin) => runPluginExecution(plugin, touchedFiles, config, ctx)),
  );

  const analyzerResults = executions
    .map((execution) => execution.result)
    .filter((result): result is AnalyzerResult => result !== undefined);
  const analyzedFiles = [...new Set(executions.flatMap((execution) => execution.selectedFiles))].sort((a, b) =>
    a.localeCompare(b),
  );
  const analyzerWarnings = executions
    .map((execution) => execution.warning)
    .filter((warning): warning is string => warning !== undefined);

  const touchedFileAnalyzerResults = filterAnalyzerResultsByTouchedFiles(analyzerResults, touchedFiles);

  return {
    enabledAnalyzers: enabledPlugins.map((plugin) => plugin.name),
    analyzedFiles,
    analyzerResults: touchedFileAnalyzerResults,
    analyzerWarnings,
    violations: evaluateAnalyzerResults(touchedFileAnalyzerResults, config.thresholds),
  };
}

async function runPluginExecution(
  plugin: AnalyzerPlugin<MetricEnforcerConfig, CcshAnalyzerContext>,
  touchedFiles: readonly string[],
  config: MetricEnforcerConfig,
  ctx: CcshAnalyzerContext,
): Promise<MetricAnalyzerExecution> {
  const selectedFiles = plugin.selectFiles(touchedFiles, config);

  if (selectedFiles.length === 0) {
    return {
      selectedFiles,
    };
  }

  try {
    const result = await plugin.analyze(selectedFiles, config, ctx);

    return {
      selectedFiles,
      result,
    };
  } catch (error) {
    if (isExecutableNotFoundError(error)) {
      const missingExecutable = error.path ?? plugin.name;
      return {
        selectedFiles,
        warning: `Analyzer "${plugin.name}" skipped: executable "${missingExecutable}" was not found in PATH.`,
      };
    }

    throw error;
  }
}

function isExecutableNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return getErrorCode(error) === "ENOENT";
}

export function filterAnalyzerResultsByTouchedFiles(
  analyzerResults: readonly AnalyzerResult[],
  touchedFiles: readonly string[],
): AnalyzerResult[] {
  const touchedFilePathSet = new Set(touchedFiles);

  return analyzerResults
    .map((result) => ({
      analyzer: result.analyzer,
      files: result.files.filter((fileMetrics) => touchedFilePathSet.has(fileMetrics.filePath)),
    }))
    .filter((result) => result.files.length > 0);
}
