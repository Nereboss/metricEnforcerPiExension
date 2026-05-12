import type { BackpressureConfig } from "./config/types.ts";
import type { Violation } from "./types.ts";
import { formatMetricValue } from "./utils.ts";

const BACKPRESSURE_MESSAGE_HEADER_LINES = [
  "MetricEnforcer detected threshold issues in touched files.",
  "Please follow these instructions:",
  "- ERROR violations: refactor now to reduce the metric below its error threshold.",
  "- WARNING violations: metric is close to threshold; if you keep touching the file, consider refactoring to reduce it.",
  "",
  "Violations:",
] as const;


export function selectBackpressureViolations(
  violations: readonly Violation[],
  backpressureConfig: BackpressureConfig,
): Violation[] {
  return backpressureConfig.errorOnly
    ? violations.filter((violation) => violation.severity === "error")
    : [...violations];
}

export function formatBackpressureUserMessage(violations: readonly Violation[]): string {
  return [...BACKPRESSURE_MESSAGE_HEADER_LINES, ...formatViolationsByFileLines(violations)].join("\n");
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
  return `  - ${violation.severity.toUpperCase()}: ${violation.metric}=${formatMetricValue(violation.actual)} (threshold ${formatMetricValue(violation.threshold)})`;
}

function formatViolationsByFileLines(violations: readonly Violation[]): string[] {
  const groupedViolationsByFilePath = groupViolationsByFilePath(violations);
  const sortedFilePaths = [...groupedViolationsByFilePath.keys()].sort((a, b) => a.localeCompare(b));

  if (sortedFilePaths.length === 0) {
    return ["- none"];
  }

  return sortedFilePaths.flatMap((filePath) => {
    const fileViolations = groupedViolationsByFilePath.get(filePath) ?? [];
    return formatFileViolationLines(filePath, fileViolations);
  });
}
