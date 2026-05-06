import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { MetricEnforcerConfig } from "../config/types.ts";
import type { AnalyzerResult, FileMetrics } from "../types.ts";
import type { AnalyzerPlugin } from "./analyzer-plugin.ts";

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

  async analyze(_files: readonly string[], config: MetricEnforcerConfig, ctx: CcshAnalyzerContext): Promise<AnalyzerResult> {
    const analyzerConfig = config.analyzers[CCSH_ANALYZER_NAME];
    if (analyzerConfig === undefined) {
      throw new Error(`[metric-enforcer] Analyzer config "${CCSH_ANALYZER_NAME}" is missing.`);
    }

    const command = analyzerConfig.command;
    if (command === undefined || command.trim().length === 0) {
      throw new Error(`[metric-enforcer] Analyzer "${CCSH_ANALYZER_NAME}" requires "command" in config.`);
    }

    const cliArgs = [...(analyzerConfig.args ?? [])];
    const workingDirectory = ctx.cwd ?? process.cwd();
    const outputFilePath = getConfiguredOutputFilePath(cliArgs, workingDirectory);

    if (outputFilePath === undefined) {
      throw new Error(
        `[metric-enforcer] Analyzer "${CCSH_ANALYZER_NAME}" requires -o/--output-file in config args so analysis can be cached.`,
      );
    }

    await mkdir(dirname(outputFilePath), { recursive: true });

    await ctx.execFile(command, cliArgs, workingDirectory);

    let analysisOutput: string;
    try {
      analysisOutput = await readFile(outputFilePath, "utf8");
    } catch (error) {
      throw new Error(
        `[metric-enforcer] ${CCSH_ANALYZER_NAME} did not create readable output at ${outputFilePath}. Ensure the configured output is uncompressed (for example add --not-compressed/-nc). ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (analysisOutput.trim().length === 0) {
      throw new Error(`[metric-enforcer] ${CCSH_ANALYZER_NAME} returned no parseable output.`);
    }

    return parseCcshUnifiedParserJson(analysisOutput);
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

function getConfiguredOutputFilePath(args: readonly string[], cwd: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if ((arg === "-o" || arg === "--output-file") && args[index + 1] !== undefined) {
      return resolvePath(cwd, args[index + 1]);
    }

    if (arg.startsWith("--output-file=") || arg.startsWith("-o=")) {
      return resolvePath(cwd, arg.split("=", 2)[1]);
    }
  }

  return undefined;
}

function resolvePath(cwd: string, candidatePath: string): string {
  return isAbsolute(candidatePath) ? candidatePath : join(cwd, candidatePath);
}
