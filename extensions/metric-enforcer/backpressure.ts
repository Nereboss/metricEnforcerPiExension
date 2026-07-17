import type { BackpressureConfig } from "./config/types.ts";
import type { Violation } from "./types.ts";
import { formatMetricValue } from "./utils.ts";

const BACKPRESSURE_MESSAGE_HEADER = "Threshold violations in files you touched this turn:";

export function selectBackpressureViolations(
  violations: readonly Violation[],
  backpressureConfig: BackpressureConfig,
): Violation[] {
  return backpressureConfig.errorOnly
    ? violations.filter((violation) => violation.severity === "error")
    : [...violations];
}

/**
 * Formats the backpressure message with only the data that changes turn to turn: the violations.
 * The static context — what error/warning mean, the "refactor silently then continue" directive, and
 * the metric definitions — lives once in the system-prompt policy, so it is not repeated here.
 */
export function formatBackpressureMessage(violations: readonly Violation[]): string {
  return [BACKPRESSURE_MESSAGE_HEADER, ...formatViolationsByFileLines(violations)].join("\n");
}

export function formatRetriesExhaustedWarning(
  violations: readonly Violation[],
  configuredMaxRetries: number,
): string {
  if (configuredMaxRetries === -1) {
    throw new Error("configuredMaxRetries must not be -1 when this function is called");
  }

  return [
    `Metric violations are still present after ${configuredMaxRetries} allowed backpressure retries. The agent could not fix them. Remaining violations:`,
    ...formatViolationsByFileLines(violations),
  ].join("\n");
}

function groupViolationsByFilePath(violations: readonly Violation[]): Map<string, Violation[]> {
  const groupedViolationsByFilePath = new Map<string, Violation[]>();

  for (const violation of violations) {
    if (!groupedViolationsByFilePath.has(violation.filePath)) {
      groupedViolationsByFilePath.set(violation.filePath, []);
    }

    groupedViolationsByFilePath.get(violation.filePath)?.push(violation);
  }

  return groupedViolationsByFilePath;
}

function formatFileViolationLines(filePath: string, violations: readonly Violation[]): string[] {
  const sortedViolations = [...violations].sort(compareViolations);
  const details = sortedViolations.map(formatViolationDetailLine);

  return [`- ${filePath}`, ...details];
}

function compareViolations(left: Violation, right: Violation): number {
  const severityDiff = left.severity.localeCompare(right.severity);
  return severityDiff !== 0 ? severityDiff : left.metric.localeCompare(right.metric);
}

function formatViolationDetailLine(violation: Violation): string {
  // Every violation is an upper-bound breach (the evaluator only fires on actual > threshold), so the
  // threshold is the maximum allowed value. Labelling it "max" tells the model which way to move.
  return `  - ${violation.severity.toUpperCase()} ${violation.metric} ${formatMetricValue(violation.actual)} (max ${formatMetricValue(violation.threshold)})`;
}

function formatViolationsByFileLines(violations: readonly Violation[]): string[] {
  const groupedViolationsByFilePath = groupViolationsByFilePath(violations);
  const sortedFilePaths = [...groupedViolationsByFilePath.keys()].sort((a, b) => a.localeCompare(b));

  if (sortedFilePaths.length === 0) return ["- none"];

  return sortedFilePaths.flatMap((filePath) => {
    const fileViolations = groupedViolationsByFilePath.get(filePath) ?? [];
    return formatFileViolationLines(filePath, fileViolations);
  });
}
