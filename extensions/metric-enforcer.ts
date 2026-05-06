import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Violation } from "./metric-enforcer/types.ts";
import { loadMetricEnforcerConfig } from "./metric-enforcer/config/loader.ts";
import { runMetricOrchestration } from "./metric-enforcer/orchestrator.ts";
import { formatMetricValue } from "./metric-enforcer/utils.ts";

const execFileAsync = promisify(execFile);
const MISSING_FILE_HASH = "__MISSING__";

let baselineSnapshot = createEmptySnapshot();
let isMetricEnforcerActive = true;

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

export default function metricEnforcer(pi: ExtensionAPI) {
  pi.registerCommand("activateMetricEnforcer", {
    description: "Activate metric enforcement for upcoming agent runs",
    handler: async (_args, ctx) => {
      if (isMetricEnforcerActive) {
        if (ctx.hasUI) {
          ctx.ui.notify("MetricEnforcer is already active.", "info");
        }
        return;
      }

      isMetricEnforcerActive = true;

      if (ctx.hasUI) {
        ctx.ui.notify("MetricEnforcer activated.", "success");
      }
    },
  });

  pi.registerCommand("deactivateMetricEnforcer", {
    description: "Deactivate metric enforcement for upcoming agent runs",
    handler: async (_args, ctx) => {
      if (!isMetricEnforcerActive) {
        if (ctx.hasUI) {
          ctx.ui.notify("MetricEnforcer is already deactivated.", "info");
        }
        return;
      }

      isMetricEnforcerActive = false;
      baselineSnapshot = createEmptySnapshot();

      if (ctx.hasUI) {
        ctx.ui.notify("MetricEnforcer deactivated.", "success");
      }
    },
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;

    try {
      await runGit(["rev-parse", "--is-inside-work-tree"]);
      baselineSnapshot = await getWorkingTreeSnapshot();
    } catch (error) {
      baselineSnapshot = createEmptySnapshot();
      const message = `Could not capture git baseline: ${error instanceof Error ? error.message : String(error)}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      console.error(`[metric-enforcer] ${message}`);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;

    try {
      const endSnapshot = await getWorkingTreeSnapshot();
      const changedByAgent = getChangedFilesBetweenSnapshots(baselineSnapshot, endSnapshot);
      const touchedFilesMessage = formatMessageForTouchedFiles(changedByAgent);

      if (ctx.hasUI) {
        ctx.ui.notify(touchedFilesMessage, "info");
      }

      const loadedConfig = await loadMetricEnforcerConfig();

      if (loadedConfig.warning !== undefined) {
        if (ctx.hasUI) {
          ctx.ui.notify(loadedConfig.warning, "warning");
        }
        console.warn(loadedConfig.warning);
      }

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

      if (ctx.hasUI) {
        ctx.ui.notify(
          orchestrationResult.enabledAnalyzers.length === 0
            ? `Metric config loaded from ${loadedConfig.sourcePath}. No analyzers enabled.`
            : `Metric config loaded from ${loadedConfig.sourcePath}. Enabled analyzers: ${orchestrationResult.enabledAnalyzers.join(", ")}`,
          "info",
        );

        for (const analyzerWarning of orchestrationResult.analyzerWarnings) {
          ctx.ui.notify(analyzerWarning, "warning");
        }

        ctx.ui.notify(formatViolationsSummary(orchestrationResult.violations), "info");
      }
    } catch (error) {
      const message = `Agent loop ended, but metric enforcement failed: ${error instanceof Error ? error.message : String(error)}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      console.error(`[metric-enforcer] ${message}`);
    } finally {
      baselineSnapshot = createEmptySnapshot();
    }
  });
}
