import type { MetricEnforcerConfig } from "./config/types.js";
import type { AnalyzerResult, Violation } from "./types.js";
import type { AnalyzerPlugin } from "./analyzers/analyzer-plugin.js";
import { ccshAnalyzerPlugin, type CcshAnalyzerContext } from "./analyzers/ccsh-analyzer.js";
import { evaluateAnalyzerResults } from "./rules/evaluator.js";

interface MetricAnalyzerExecution {
  selectedFiles: string[];
  result: AnalyzerResult;
  skipped: boolean;
}

const analyzerPlugins: AnalyzerPlugin<MetricEnforcerConfig, CcshAnalyzerContext>[] = [ccshAnalyzerPlugin];

export interface OrchestrationResult {
  enabledAnalyzers: string[];
  analyzedFiles: string[];
  analyzerResults: AnalyzerResult[];
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

  return {
    enabledAnalyzers: enabledPlugins.map((plugin) => plugin.name),
    analyzedFiles,
    analyzerResults,
    violations: evaluateAnalyzerResults(analyzerResults, config.thresholds),
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

  const result = await plugin.analyze(selectedFiles, config, ctx);

  return {
    selectedFiles,
    result,
    skipped: false,
  };
}
