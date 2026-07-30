import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Violation } from "./metric-enforcer/types.ts";
import { loadMetricEnforcerConfig } from "./metric-enforcer/config/loader.ts";
import { logError, logInfo, logWarning } from "./metric-enforcer/logger.ts";
import {
  collectMetricDefinitions,
  runMetricOrchestration,
  type OrchestrationResult,
} from "./metric-enforcer/orchestrator.ts";
import {
  formatBackpressureMessage,
  formatRetriesExhaustedWarning,
  selectBackpressureViolations,
} from "./metric-enforcer/backpressure.ts";
import { formatMetricValue } from "./metric-enforcer/utils.ts";
import {
  formatMetricDefinitionsSection,
  getMessagesFromContextEvent,
  getSystemPromptFromBeforeAgentStartEvent,
  pruneOldQualityGateMessages,
  QUALITY_GATE_CUSTOM_TYPE,
  QUALITY_GATE_POLICY_FILE_NAME,
} from "./metric-enforcer/quality-gate.ts";

const execFileAsync = promisify(execFile);
const MISSING_FILE_HASH = "__MISSING__";
// in case an analyzer fails, try it a max of this many times
const MAX_ANALYSIS_ATTEMPTS = 3;
const GIT_UNAVAILABLE_MESSAGE =
  "The current directory is not a git repository. " +
  "Metric enforcer relies on git to detect changed files, it has been deactivated.";

let turnStartSnapshot = createEmptySnapshot();
let cumulativeAgentTouchedFiles = new Set<string>();
let isMetricEnforcerActive = true;
let configuredLogLevel: "info" | "warning" | "error" = "warning";
let backpressureRetryCount = 0;
let qualityGateMessagesSentInCurrentCycle = 0;
let shouldResetTrackingOnNextAgentStart = true;
let gitUnavailableNoticeShown = false;
// Warning messages already emitted in the current user turn, so retries within the turn don't repeat them.
let warningsEmittedThisTurn = new Set<string>();

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

async function isInsideGitRepository(): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
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
  if (files.length === 0) return "Agent changed no files.";

  return `Agent changed files:\n${files.join("\n")}`;
}

function formatViolationsSummary(violations: readonly Violation[]): string {
  if (violations.length === 0) return "Metric checks passed. No threshold violations found.";

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


function getQualityGatePolicyFileUrl(): URL {
  return new URL(`../${QUALITY_GATE_POLICY_FILE_NAME}`, import.meta.url);
}

async function loadQualityGatePolicyInstructions(ctx: ExtensionHandlerContext): Promise<string | undefined> {
  const policyFileUrl = getQualityGatePolicyFileUrl();
  const policyFilePath = fileURLToPath(policyFileUrl);

  try {
    const policyMarkdown = (await readFile(policyFileUrl, "utf8")).trim();

    if (policyMarkdown.length === 0) {
      logWarningOncePerTurn(`Quality-gate policy file at ${policyFilePath} is empty.`, ctx);
      return undefined;
    }

    return policyMarkdown;
  } catch (error) {
    const errorDetails = error instanceof Error ? error.message : String(error);
    logWarningOncePerTurn(`Could not read quality-gate policy file at ${policyFilePath}: ${errorDetails}`, ctx);
    return undefined;
  }
}

/**
 * Appends the metric definitions to the quality-gate policy so the model receives them once in the
 * system prompt rather than on every backpressure message. Definitions come from the enabled analyzers
 * (the tools that emit the metrics), so only metrics that can appear this run are described; config can
 * override individual entries. If the config cannot be loaded we keep the policy as-is: missing
 * definitions degrade the guidance but should not block the run.
 */
async function appendMetricDefinitionsToPolicy(policy: string, ctx: ExtensionHandlerContext): Promise<string> {
  let config: LoadedMetricConfig["config"];

  try {
    config = (await loadMetricEnforcerConfig()).config;
  } catch (error) {
    const errorDetails = error instanceof Error ? error.message : String(error);
    logWarningOncePerTurn(`Could not load metric definitions for the system prompt: ${errorDetails}`, ctx);
    return policy;
  }

  const { definitions, warnings } = collectMetricDefinitions(config);

  for (const warning of warnings) {
    logWarningOncePerTurn(warning, ctx);
  }

  const definitionsSection = formatMetricDefinitionsSection(definitions);
  return definitionsSection === undefined ? policy : `${policy}\n\n${definitionsSection}`;
}

type ExtensionHandlerContext = Parameters<typeof logWarning>[2];
type LoadedMetricConfig = Awaited<ReturnType<typeof loadMetricEnforcerConfig>>;

function applyConfiguredLogLevel(logLevel: "info" | "warning" | "error"): void {
  configuredLogLevel = logLevel;
}

/**
 * Emits a warning only the first time it is seen in the current user turn. Config and analyzer warnings
 * are recomputed on every backpressure retry within a turn, so without this they would be logged again
 * on each retry. The set is cleared when the next user turn begins, so genuine issues resurface then.
 */
function logWarningOncePerTurn(message: string, ctx: ExtensionHandlerContext): void {
  if (warningsEmittedThisTurn.has(message)) return;

  warningsEmittedThisTurn.add(message);
  logWarning(message, configuredLogLevel, ctx);
}

function logConfigWarnings(warnings: readonly string[], ctx: ExtensionHandlerContext): void {
  for (const warning of warnings) {
    logWarningOncePerTurn(warning, ctx);
  }
}

function resetTrackingStateForNewCycle(): void {
  backpressureRetryCount = 0;
  qualityGateMessagesSentInCurrentCycle = 0;
  cumulativeAgentTouchedFiles = new Set<string>();
  shouldResetTrackingOnNextAgentStart = false;
}

function clearTrackingAndMarkNextAgentStartAsNewCycle(): void {
  backpressureRetryCount = 0;
  qualityGateMessagesSentInCurrentCycle = 0;
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
    turnStartSnapshot = await getWorkingTreeSnapshot();
  } catch (error) {
    turnStartSnapshot = createEmptySnapshot();
    const message = `Could not capture git baseline: ${error instanceof Error ? error.message : String(error)}`;
    logError(message, configuredLogLevel, ctx);
  }
}

// Returns true when metric enforcement can run. When the directory is not a git
// repository it surfaces a single error so the user knows the extension is
// inactive, then stays silent on subsequent events to avoid repeated failures.
async function ensureGitRepositoryAvailable(ctx: ExtensionHandlerContext): Promise<boolean> {
  if (await isInsideGitRepository()) return true;

  if (!gitUnavailableNoticeShown) {
    logError(GIT_UNAVAILABLE_MESSAGE, configuredLogLevel, ctx);
    gitUnavailableNoticeShown = true;
  }

  return false;
}

/**
 * Runs the enabled analyzers, retrying the whole orchestration for as long as it keeps failing.
 * Only losing every attempt is reported, so a transient analyzer crash stays a non-event instead of
 * silently disabling enforcement for the turn. Retries are immediate: the failures seen so far are
 * races that a second process start already avoids, and waiting would stall the agent.
 *
 * Returns undefined when no attempt produced a result — the caller must not treat that as a passed
 * gate.
 */
async function runMetricOrchestrationWithRetries(
  touchedFiles: readonly string[],
  config: LoadedMetricConfig["config"],
  ctx: ExtensionHandlerContext,
): Promise<OrchestrationResult | undefined> {
  for (let attempt = 1; attempt <= MAX_ANALYSIS_ATTEMPTS; attempt += 1) {
    try {
      return await runMetricOrchestration(touchedFiles, config, createAnalyzerExecutionContext());
    } catch (error) {
      const errorDetails = error instanceof Error ? error.message : String(error);

      if (attempt < MAX_ANALYSIS_ATTEMPTS) {
        logInfo(
          `Metric analysis attempt ${attempt} of ${MAX_ANALYSIS_ATTEMPTS} failed, retrying: ${errorDetails}`,
          configuredLogLevel,
          ctx,
        );
        continue;
      }

      logError(
        `Metric analysis could not be run: all ${MAX_ANALYSIS_ATTEMPTS} attempts failed, ` +
          `so no quality gate was applied to this turn. Last error: ${errorDetails}`,
        configuredLogLevel,
        ctx,
      );
    }
  }

  return undefined;
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
    pi.sendMessage(
      {
        customType: QUALITY_GATE_CUSTOM_TYPE,
        content: formatBackpressureMessage(backpressureViolations),
        display: true,
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    qualityGateMessagesSentInCurrentCycle += 1;
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
  gitUnavailableNoticeShown = false;
  warningsEmittedThisTurn = new Set<string>();

  // Surface the "not a git repository" error once when the extension loads so
  // the user knows it cannot work here, before any agent run is attempted.
  pi.on("session_start", async (_event, ctx) => {
    await ensureGitRepositoryAvailable(ctx);
  });

  pi.registerCommand("activateMetricEnforcer", {
    description: "Activate metric enforcement for upcoming agent runs",
    handler: async (_args, ctx) => {
      if (!(await isInsideGitRepository())) {
        logError(GIT_UNAVAILABLE_MESSAGE, configuredLogLevel, ctx);
        return;
      }

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

  pi.on("before_agent_start", async (event, ctx) => {
    if (!isMetricEnforcerActive) return undefined;

    const currentSystemPrompt = getSystemPromptFromBeforeAgentStartEvent(event);
    const qualityGatePolicyInstructions = await loadQualityGatePolicyInstructions(ctx);

    if (currentSystemPrompt === undefined || qualityGatePolicyInstructions === undefined) return undefined;

    const qualityGatePolicy = await appendMetricDefinitionsToPolicy(qualityGatePolicyInstructions, ctx);

    return {
      systemPrompt: `${currentSystemPrompt}\n\n${qualityGatePolicy}`,
    };
  });

  pi.on("context", async (event) => {
    const messages = getMessagesFromContextEvent(event);

    if (messages === undefined) return undefined;

    return {
      // filter out all messages from our extension from a previous user message from the model context
      messages: pruneOldQualityGateMessages(messages, qualityGateMessagesSentInCurrentCycle),
    };
  });

  pi.on("input", async (event) => {
    if (event.source !== "extension") {
      shouldResetTrackingOnNextAgentStart = true;
      // A new user turn: let warnings surface again instead of staying suppressed from the previous turn.
      warningsEmittedThisTurn.clear();
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;
    if (!(await ensureGitRepositoryAvailable(ctx))) return;

    if (shouldResetTrackingOnNextAgentStart) {
      resetTrackingStateForNewCycle();
    }

    await loadConfigWithAppliedLogLevel(ctx, "agent start");
    await captureTurnStartSnapshot(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!isMetricEnforcerActive) return;
    if (!(await ensureGitRepositoryAvailable(ctx))) return;

    try {
      const endSnapshot = await getWorkingTreeSnapshot();
      const changedByAgentThisTurn = getChangedFilesBetweenSnapshots(turnStartSnapshot, endSnapshot);

      addTouchedFilesToTracking(changedByAgentThisTurn);

      const loadedConfig = await loadConfigWithAppliedLogLevel(ctx, "agent end");

      if (loadedConfig === undefined) return;

      logInfo(formatMessageForTouchedFiles(changedByAgentThisTurn), configuredLogLevel, ctx);

      const existingTouchedFiles = getCurrentlyTrackedExistingFiles(endSnapshot);
      const orchestrationResult = await runMetricOrchestrationWithRetries(
        existingTouchedFiles,
        loadedConfig.config,
        ctx,
      );

      if (orchestrationResult === undefined) return;

      logInfo(
        orchestrationResult.enabledAnalyzers.length === 0
          ? `Metric config loaded from ${loadedConfig.sourcePath}. No analyzers enabled.`
          : `Metric config loaded from ${loadedConfig.sourcePath}. Enabled analyzers: ${orchestrationResult.enabledAnalyzers.join(", ")}`,
        configuredLogLevel,
        ctx,
      );

      for (const analyzerWarning of orchestrationResult.analyzerWarnings) {
        logWarningOncePerTurn(analyzerWarning, ctx);
      }

      logInfo(formatViolationsSummary(orchestrationResult.violations), configuredLogLevel, ctx);

      handleBackpressureResult(pi, loadedConfig, orchestrationResult.violations, ctx);
    } catch (error) {
      const message = `Agent loop ended, but metric enforcement failed: ${error instanceof Error ? error.message : String(error)}`;
      logError(message, configuredLogLevel, ctx);
    }
  });
}
