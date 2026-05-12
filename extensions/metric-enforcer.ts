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

let baselineSnapshot = createEmptySnapshot();
let isMetricEnforcerActive = true;
let configuredLogLevel: "info" | "warning" | "error" = "warning";
let backpressureRetryCount = 0;
let awaitingBackpressureResolution = false;

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

function applyConfiguredLogLevel(logLevel: "info" | "warning" | "error"): void {
  configuredLogLevel = logLevel;
}

function logConfigWarnings(warnings: readonly string[], ctx: Parameters<typeof logWarning>[2]): void {
  for (const warning of warnings) {
    logWarning(warning, configuredLogLevel, ctx);
  }
}

export default function metricEnforcer(pi: ExtensionAPI) {
  baselineSnapshot = createEmptySnapshot();
  isMetricEnforcerActive = true;
  configuredLogLevel = "warning";
  backpressureRetryCount = 0;
  awaitingBackpressureResolution = false;

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
      baselineSnapshot = createEmptySnapshot();
      backpressureRetryCount = 0;
      awaitingBackpressureResolution = false;
      logInfo("MetricEnforcer deactivated.", configuredLogLevel, ctx);
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;

    if (!awaitingBackpressureResolution) {
      backpressureRetryCount = 0;
    }

    try {
      const loadedConfig = await loadMetricEnforcerConfig();
      applyConfiguredLogLevel(loadedConfig.config.logLevel);
      logConfigWarnings(loadedConfig.warnings, ctx);
    } catch (error) {
      const message = `Could not load metric config at agent start: ${error instanceof Error ? error.message : String(error)}`;
      logError(message, configuredLogLevel, ctx);
    }

    try {
      await runGit(["rev-parse", "--is-inside-work-tree"]);
      baselineSnapshot = await getWorkingTreeSnapshot();
    } catch (error) {
      baselineSnapshot = createEmptySnapshot();
      const message = `Could not capture git baseline: ${error instanceof Error ? error.message : String(error)}`;
      logError(message, configuredLogLevel, ctx);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;

    try {
      const endSnapshot = await getWorkingTreeSnapshot();
      const changedByAgent = getChangedFilesBetweenSnapshots(baselineSnapshot, endSnapshot);

      const loadedConfig = await loadMetricEnforcerConfig();
      applyConfiguredLogLevel(loadedConfig.config.logLevel);

      logInfo(formatMessageForTouchedFiles(changedByAgent), configuredLogLevel, ctx);
      logConfigWarnings(loadedConfig.warnings, ctx);

      const existingTouchedFiles = filterExistingFiles(changedByAgent, endSnapshot);
      const orchestrationResult = await runMetricOrchestration(existingTouchedFiles, loadedConfig.config, {
        cwd: process.cwd(),
        execFile: async (command, args, cwd) =>
          execFileAsync(command, [...args], {
            cwd,
            encoding: "utf8",
            maxBuffer: 20 * 1024 * 1024,
          }),
      });

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

      const backpressureViolations = selectBackpressureViolations(
        orchestrationResult.violations,
        loadedConfig.config.backpressure,
      );

      if (backpressureViolations.length === 0) {
        backpressureRetryCount = 0;
        awaitingBackpressureResolution = false;
        return;
      }

      const maxBackpressureRetries = loadedConfig.config.backpressure.maxBackpressureRetries;

      if (maxBackpressureRetries === -1 || backpressureRetryCount < maxBackpressureRetries) {
        backpressureRetryCount += 1;
        awaitingBackpressureResolution = true;
        pi.sendUserMessage(formatBackpressureUserMessage(backpressureViolations));
        return;
      }

      const retriesExhaustedMessage = formatRetriesExhaustedWarning(backpressureViolations, maxBackpressureRetries);
      logWarning(retriesExhaustedMessage, configuredLogLevel, ctx);
      backpressureRetryCount = 0;
      awaitingBackpressureResolution = false;
    } catch (error) {
      const message = `Agent loop ended, but metric enforcement failed: ${error instanceof Error ? error.message : String(error)}`;
      logError(message, configuredLogLevel, ctx);
    } finally {
      baselineSnapshot = createEmptySnapshot();
    }
  });
}
