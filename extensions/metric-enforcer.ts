import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Violation } from "./metric-enforcer/types.ts";
import { loadMetricEnforcerConfig } from "./metric-enforcer/config/loader.ts";
import { logError, logInfo, logWarning } from "./metric-enforcer/logger.ts";
import { runMetricOrchestration } from "./metric-enforcer/orchestrator.ts";
import {
  formatBackpressureUserMessage,
  formatRetriesExhaustedWarning,
  selectBackpressureViolations,
} from "./metric-enforcer/backpressure.ts";
import { formatMetricValue } from "./metric-enforcer/utils.ts";

const execFileAsync = promisify(execFile);
const MISSING_FILE_HASH = "__MISSING__";

let turnStartSnapshot = createEmptySnapshot();
let cumulativeAgentTouchedFiles = new Set<string>();
let isMetricEnforcerActive = true;
let configuredLogLevel: "info" | "warning" | "error" = "warning";
let backpressureRetryCount = 0;
let shouldResetTrackingOnNextAgentStart = true;

function parsePorcelainV1ZPaths(output: string): string[] {
  const entries = output.split("\0").filter((entry) => entry.length > 0);
  const changedPaths = new Set<string>();

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const status = entry.slice(0, 2);
    const primaryPath = entry.slice(3);

    if (primaryPath.length > 0) {
      changedPaths.add(primaryPath);
    }

    const isRenameOrCopy = status.includes("R") || status.includes("C");

    if (isRenameOrCopy && entries[index + 1] !== undefined) {
      const renamedOrCopiedPath = entries[index + 1];
      if (renamedOrCopiedPath.length > 0) {
        changedPaths.add(renamedOrCopiedPath);
      }
      index += 1;
    }
  }

  return [...changedPaths].sort((a, b) => a.localeCompare(b));
}

async function runGit(args: readonly string[]) {
  return execFileAsync("git", args, { encoding: "utf8" });
}

async function getWorkingTreeSnapshot(): Promise<Map<string, string>> {
  // use --porcelain=v1 to get status output optimized for tool use
  const { stdout } = await runGit(["status", "--porcelain=v1", "--untracked-files=all", "-z"]);
  const changedPaths = parsePorcelainV1ZPaths(stdout);

  const entries = await Promise.all(
    changedPaths.map(async (filePath) => {
      try {
        const { stdout: hash } = await runGit(["hash-object", "--", filePath]);
        return [filePath, hash.trim()] as const;
      } catch {
        return [filePath, MISSING_FILE_HASH] as const;
      }
    }),
  );

  return new Map(entries);
}

function getChangedFilesBetweenSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const allFiles = new Set<string>([...before.keys(), ...after.keys()]);

  return [...allFiles]
    .filter((file) => before.get(file) !== after.get(file))
    .sort((a, b) => a.localeCompare(b));
}

function formatMessageForTouchedFiles(files: string[]): string {
  if (files.length === 0) {
    return "Agent changed no files.";
  }

  return `Agent changed files:\n${files.join("\n")}`;
}

function formatViolationsSummary(violations: readonly Violation[]): string {
  if (violations.length === 0) {
    return "Metric checks passed. No threshold violations found.";
  }

  const errorCount = violations.filter((violation) => violation.severity === "error").length;
  const warningCount = violations.length - errorCount;
  const previewLimit = 8;
  const previewLines = violations.slice(0, previewLimit).map((violation) => {
    const actualValue = formatMetricValue(violation.actual);
    const thresholdValue = formatMetricValue(violation.threshold);

    return `${violation.severity.toUpperCase()}: ${violation.filePath} | ${violation.metric}=${actualValue} > ${thresholdValue}`;
  });

  const moreCount = violations.length - previewLimit;
  const moreLine = moreCount > 0 ? `\n... and ${moreCount} more violation(s).` : "";

  return `Metric violations found (${errorCount} error, ${warningCount} warning):\n${previewLines.join("\n")}${moreLine}`;
}

function createEmptySnapshot(): Map<string, string> {
  return new Map<string, string>();
}

function filterExistingFiles(files: readonly string[], snapshot: Map<string, string>): string[] {
  return files.filter((filePath) => snapshot.has(filePath));
}

function toSortedFilePathArray(filePaths: ReadonlySet<string>): string[] {
  return [...filePaths].sort((a, b) => a.localeCompare(b));
}

type ExtensionHandlerContext = Parameters<typeof logWarning>[2];
type LoadedMetricConfig = Awaited<ReturnType<typeof loadMetricEnforcerConfig>>;

function applyConfiguredLogLevel(logLevel: "info" | "warning" | "error"): void {
  configuredLogLevel = logLevel;
}

function logConfigWarnings(warnings: readonly string[], ctx: ExtensionHandlerContext): void {
  for (const warning of warnings) {
    logWarning(warning, configuredLogLevel, ctx);
  }
}

function resetTrackingStateForNewCycle(): void {
  backpressureRetryCount = 0;
  cumulativeAgentTouchedFiles = new Set<string>();
  shouldResetTrackingOnNextAgentStart = false;
}

function clearTrackingAndMarkNextAgentStartAsNewCycle(): void {
  backpressureRetryCount = 0;
  turnStartSnapshot = createEmptySnapshot();
  cumulativeAgentTouchedFiles = new Set<string>();
  shouldResetTrackingOnNextAgentStart = true;
}

function addTouchedFilesToTracking(files: readonly string[]): void {
  for (const filePath of files) {
    cumulativeAgentTouchedFiles.add(filePath);
  }
}

function getCurrentlyTrackedExistingFiles(snapshot: Map<string, string>): string[] {
  return filterExistingFiles(toSortedFilePathArray(cumulativeAgentTouchedFiles), snapshot);
}

function createAnalyzerExecutionContext() {
  return {
    cwd: process.cwd(),
    execFile: async (command: string, args: readonly string[], cwd?: string) =>
      execFileAsync(command, [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      }),
  };
}

async function loadConfigWithAppliedLogLevel(ctx: ExtensionHandlerContext, phase: "agent start" | "agent end") {
  try {
    const loadedConfig = await loadMetricEnforcerConfig();
    applyConfiguredLogLevel(loadedConfig.config.logLevel);
    logConfigWarnings(loadedConfig.warnings, ctx);
    return loadedConfig;
  } catch (error) {
    const message = `Could not load metric config at ${phase}: ${error instanceof Error ? error.message : String(error)}`;
    logError(message, configuredLogLevel, ctx);
    return undefined;
  }
}

async function captureTurnStartSnapshot(ctx: ExtensionHandlerContext): Promise<void> {
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"]);
    turnStartSnapshot = await getWorkingTreeSnapshot();
  } catch (error) {
    turnStartSnapshot = createEmptySnapshot();
    const message = `Could not capture git baseline: ${error instanceof Error ? error.message : String(error)}`;
    logError(message, configuredLogLevel, ctx);
  }
}

function handleBackpressureResult(
  pi: ExtensionAPI,
  loadedConfig: LoadedMetricConfig,
  violations: readonly Violation[],
  ctx: ExtensionHandlerContext,
): void {
  const backpressureViolations = selectBackpressureViolations(violations, loadedConfig.config.backpressure);

  if (backpressureViolations.length === 0) {
    clearTrackingAndMarkNextAgentStartAsNewCycle();
    return;
  }

  const maxBackpressureRetries = loadedConfig.config.backpressure.maxBackpressureRetries;

  if (maxBackpressureRetries === -1 || backpressureRetryCount < maxBackpressureRetries) {
    backpressureRetryCount += 1;
    pi.sendUserMessage(formatBackpressureUserMessage(backpressureViolations));
    return;
  }

  const retriesExhaustedMessage = formatRetriesExhaustedWarning(backpressureViolations, maxBackpressureRetries);
  logWarning(retriesExhaustedMessage, configuredLogLevel, ctx);
  clearTrackingAndMarkNextAgentStartAsNewCycle();
}

export default function metricEnforcer(pi: ExtensionAPI) {
  clearTrackingAndMarkNextAgentStartAsNewCycle();
  isMetricEnforcerActive = true;
  configuredLogLevel = "warning";

  pi.registerCommand("activateMetricEnforcer", {
    description: "Activate metric enforcement for upcoming agent runs",
    handler: async (_args, ctx) => {
      if (isMetricEnforcerActive) {
        logInfo("MetricEnforcer is already active.", configuredLogLevel, ctx);
        return;
      }

      isMetricEnforcerActive = true;
      logInfo("MetricEnforcer activated.", configuredLogLevel, ctx);
    },
  });

  pi.registerCommand("deactivateMetricEnforcer", {
    description: "Deactivate metric enforcement for upcoming agent runs",
    handler: async (_args, ctx) => {
      if (!isMetricEnforcerActive) {
        logInfo("MetricEnforcer is already deactivated.", configuredLogLevel, ctx);
        return;
      }

      isMetricEnforcerActive = false;
      clearTrackingAndMarkNextAgentStartAsNewCycle();
      logInfo("MetricEnforcer deactivated.", configuredLogLevel, ctx);
    },
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      shouldResetTrackingOnNextAgentStart = true;
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;

    if (shouldResetTrackingOnNextAgentStart) {
      resetTrackingStateForNewCycle();
    }

    await loadConfigWithAppliedLogLevel(ctx, "agent start");
    await captureTurnStartSnapshot(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;

    try {
      const endSnapshot = await getWorkingTreeSnapshot();
      const changedByAgentThisTurn = getChangedFilesBetweenSnapshots(turnStartSnapshot, endSnapshot);

      addTouchedFilesToTracking(changedByAgentThisTurn);

      const loadedConfig = await loadConfigWithAppliedLogLevel(ctx, "agent end");
      
      if (loadedConfig === undefined) return;

      logInfo(formatMessageForTouchedFiles(changedByAgentThisTurn), configuredLogLevel, ctx);

      const existingTouchedFiles = getCurrentlyTrackedExistingFiles(endSnapshot);
      const orchestrationResult = await runMetricOrchestration(
        existingTouchedFiles,
        loadedConfig.config,
        createAnalyzerExecutionContext(),
      );

      logInfo(
        orchestrationResult.enabledAnalyzers.length === 0
          ? `Metric config loaded from ${loadedConfig.sourcePath}. No analyzers enabled.`
          : `Metric config loaded from ${loadedConfig.sourcePath}. Enabled analyzers: ${orchestrationResult.enabledAnalyzers.join(", ")}`,
        configuredLogLevel,
        ctx,
      );

      for (const analyzerWarning of orchestrationResult.analyzerWarnings) {
        logWarning(analyzerWarning, configuredLogLevel, ctx);
      }

      logInfo(formatViolationsSummary(orchestrationResult.violations), configuredLogLevel, ctx);

      handleBackpressureResult(pi, loadedConfig, orchestrationResult.violations, ctx);
    } catch (error) {
      const message = `Agent loop ended, but metric enforcement failed: ${error instanceof Error ? error.message : String(error)}`;
      logError(message, configuredLogLevel, ctx);
    }
  });
}
