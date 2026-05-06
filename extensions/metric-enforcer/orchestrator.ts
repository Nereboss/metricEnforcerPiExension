import type { MetricEnforcerConfig } from "./config/types.ts";
import type { AnalyzerResult, Violation } from "./types.ts";
import type { AnalyzerPlugin } from "./analyzers/analyzer-plugin.ts";
import { ccshAnalyzerPlugin, type CcshAnalyzerContext } from "./analyzers/ccsh-analyzer.ts";
import { evaluateAnalyzerResults } from "./rules/evaluator.ts";

interface MetricAnalyzerExecution {
  selectedFiles: string[];
  result: AnalyzerResult;
  skipped: boolean;
  warning?: string;
}

const analyzerPlugins: AnalyzerPlugin<MetricEnforcerConfig, CcshAnalyzerContext>[] = [ccshAnalyzerPlugin];

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

  const analyzerResults = executions.filter((execution) => !execution.skipped).map((execution) => execution.result);
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
      result: {
        analyzer: plugin.name,
        files: [],
      },
      skipped: true,
    };
  }

  try {
    const result = await plugin.analyze(selectedFiles, config, ctx);

    return {
      selectedFiles,
      result,
      skipped: false,
    };
  } catch (error) {
    if (isExecutableNotFoundError(error)) {
      const missingExecutable = error.path ?? plugin.name;
      return {
        selectedFiles,
        result: {
          analyzer: plugin.name,
          files: [],
        },
        skipped: true,
        warning: `Analyzer "${plugin.name}" skipped: executable "${missingExecutable}" was not found in PATH.`,
      };
    }

    throw error;
  }
}

function isExecutableNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
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
