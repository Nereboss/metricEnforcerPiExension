import type { MetricEnforcerConfig } from "../config/types.js";
import type { AnalyzerResult, FileMetrics } from "../types.js";
import type { AnalyzerPlugin } from "./analyzer-plugin.js";

interface CcshUnifiedParserOutput {
  data?: {
    nodes?: CcshNode[];
  };
}

interface CcshNode {
  name: string;
  type: string;
  attributes?: Record<string, unknown>;
  children?: CcshNode[];
}

export interface CcshAnalyzerContext {
  execFile(command: string, args: readonly string[], cwd?: string): Promise<{ stdout: string; stderr: string }>;
  cwd?: string;
}

const CCSH_ANALYZER_NAME = "ccsh";

export const ccshAnalyzerPlugin: AnalyzerPlugin<MetricEnforcerConfig, CcshAnalyzerContext> = {
  name: CCSH_ANALYZER_NAME,

  isEnabled(config: MetricEnforcerConfig): boolean {
    return config.analyzers[CCSH_ANALYZER_NAME]?.enabled === true;
  },

  selectFiles(files: readonly string[]): string[] {
    return [...files];
  },

  async analyze(
    files: readonly string[],
    config: MetricEnforcerConfig,
    ctx: CcshAnalyzerContext,
  ): Promise<AnalyzerResult> {
    if (files.length === 0) {
      return {
        analyzer: CCSH_ANALYZER_NAME,
        files: [],
      };
    }

    const analyzerConfig = config.analyzers[CCSH_ANALYZER_NAME];
    if (analyzerConfig === undefined) {
      throw new Error(`[metric-enforcer] Analyzer config "${CCSH_ANALYZER_NAME}" is missing.`);
    }

    const command = analyzerConfig.command ?? CCSH_ANALYZER_NAME;
    const cliArgs = [
      "unifiedparser",
      ...(analyzerConfig.args ?? []),
      ...toCliOptions(analyzerConfig.options),
      ...files,
    ];

    const { stdout, stderr } = await ctx.execFile(command, cliArgs, ctx.cwd);
    const rawOutput = stdout.trim().length > 0 ? stdout : stderr;

    if (rawOutput.trim().length === 0) {
      throw new Error(`[metric-enforcer] ${CCSH_ANALYZER_NAME} returned no parseable output.`);
    }

    return parseCcshUnifiedParserJson(rawOutput);
  },
};

export function parseCcshUnifiedParserJson(rawOutput: string): AnalyzerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOutput) as unknown;
  } catch (error) {
    throw new Error(
      `[metric-enforcer] Failed to parse ccsh unifiedparser JSON output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const output = parsed as CcshUnifiedParserOutput;
  const nodes = output.data?.nodes;

  if (nodes === undefined || !Array.isArray(nodes)) {
    throw new Error('[metric-enforcer] Invalid ccsh output: expected "data.nodes" array.');
  }

  const files = collectFileMetrics(nodes, []);

  return {
    analyzer: CCSH_ANALYZER_NAME,
    files,
  };
}

function collectFileMetrics(nodes: readonly CcshNode[], parentPathSegments: readonly string[]): FileMetrics[] {
  const metrics: FileMetrics[] = [];

  for (const node of nodes) {
    const isRootNode = parentPathSegments.length === 0 && node.name === "root";
    const pathSegments = isRootNode ? [...parentPathSegments] : [...parentPathSegments, node.name];

    if (node.type === "File") {
      metrics.push({
        filePath: pathSegments.join("/"),
        metrics: extractNumericMetrics(node.attributes),
      });
      continue;
    }

    if (Array.isArray(node.children) && node.children.length > 0) {
      metrics.push(...collectFileMetrics(node.children, pathSegments));
    }
  }

  return metrics;
}

function extractNumericMetrics(attributes: Record<string, unknown> | undefined): Record<string, number> {
  if (attributes === undefined) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
  ) as Record<string, number>;
}

function toCliOptions(options: Record<string, string | number | boolean | null> | undefined): string[] {
  if (options === undefined) {
    return [];
  }

  const args: string[] = [];

  for (const [key, value] of Object.entries(options)) {
    if (value === false || value === null) {
      continue;
    }

    if (value === true) {
      args.push(`--${key}`);
      continue;
    }

    args.push(`--${key}=${value}`);
  }

  return args;
}
