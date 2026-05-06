import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Violation } from "./metric-enforcer/types.ts";
import { loadMetricEnforcerConfig } from "./metric-enforcer/config/loader.ts";
import { runMetricOrchestration } from "./metric-enforcer/orchestrator.ts";

const execFileAsync = promisify(execFile);
const MISSING_FILE_HASH = "__MISSING__";

let baselineSnapshot = new Map<string, string>();

function parseLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runGit(args: string[]) {
  return execFileAsync("git", args, { encoding: "utf8" });
}

async function getWorkingTreeSnapshot(): Promise<Map<string, string>> {
  const { stdout } = await runGit(["ls-files", "-co", "--exclude-standard"]);
  const files = parseLines(stdout).sort((a, b) => a.localeCompare(b));

  const entries = await Promise.all(
    files.map(async (filePath) => {
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
    const actualValue = Number.isInteger(violation.actual) ? violation.actual.toString() : violation.actual.toFixed(2);
    const thresholdValue = Number.isInteger(violation.threshold)
      ? violation.threshold.toString()
      : violation.threshold.toFixed(2);

    return `${violation.severity.toUpperCase()}: ${violation.filePath} | ${violation.metric}=${actualValue} > ${thresholdValue}`;
  });

  const moreCount = violations.length - previewLimit;
  const moreLine = moreCount > 0 ? `\n... and ${moreCount} more violation(s).` : "";

  return `Metric violations found (${errorCount} error, ${warningCount} warning):\n${previewLines.join("\n")}${moreLine}`;
}

function filterExistingFiles(files: readonly string[], snapshot: Map<string, string>): string[] {
  return files.filter((filePath) => snapshot.has(filePath));
}

export default function metricEnforcer(pi: ExtensionAPI) {
  pi.on("agent_start", async (_event, ctx) => {
    try {
      await runGit(["rev-parse", "--is-inside-work-tree"]);
      baselineSnapshot = await getWorkingTreeSnapshot();
    } catch (error) {
      baselineSnapshot = new Map<string, string>();
      const message = `Could not capture git baseline: ${error instanceof Error ? error.message : String(error)}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      console.error(`[metric-enforcer] ${message}`);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
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
      baselineSnapshot = new Map<string, string>();
    }
  });
}
