import test from "node:test";
import assert from "node:assert/strict";
import {
  formatBackpressureMessage,
  formatRetriesExhaustedWarning,
  selectBackpressureViolations,
} from "../extensions/metric-enforcer/backpressure.ts";
import type { Violation } from "../extensions/metric-enforcer/types.ts";

const violations: Violation[] = [
  {
    filePath: "src/a.ts",
    metric: "complexity",
    actual: 20,
    threshold: 15,
    severity: "error",
  },
  {
    filePath: "src/a.ts",
    metric: "rloc",
    actual: 9,
    threshold: 8,
    severity: "warning",
  },
];

test("selectBackpressureViolations keeps warnings when errorOnly is false", () => {
  const selected = selectBackpressureViolations(violations, {
    errorOnly: false,
    maxBackpressureRetries: 3,
  });

  assert.equal(selected.length, 2);
});

test("selectBackpressureViolations keeps only errors when errorOnly is true", () => {
  const selected = selectBackpressureViolations(violations, {
    errorOnly: true,
    maxBackpressureRetries: 3,
  });

  assert.equal(selected.length, 1);
  assert.equal(selected[0].severity, "error");
});

test("formatBackpressureMessage includes violations, metric definitions and guidance", () => {
  const message = formatBackpressureMessage(violations, {
    complexity: "Cyclomatic complexity score of the file.",
    rloc: "Real lines of code in the file.",
  });

  assert.ok(message.includes("Violations:"));
  assert.ok(message.includes("ERROR: complexity=20"));
  assert.ok(message.includes("WARNING: rloc=9"));
  assert.ok(message.includes("Metric definitions:"));
  assert.ok(message.includes("complexity: Cyclomatic complexity score of the file."));
  assert.ok(message.includes("rloc: Real lines of code in the file."));
  assert.ok(message.includes("Please follow these instructions to handle the different violations:"));
  assert.ok(message.includes("ERROR: refactor file now"));
  assert.ok(message.includes("WARNING: metric is close to threshold"));
});

test("formatRetriesExhaustedWarning contains unresolved violations in file/metric message format", () => {
  const warning = formatRetriesExhaustedWarning(violations, 3);

  assert.ok(warning.includes("after 3 allowed backpressure retries"));
  assert.ok(warning.includes("- src/a.ts"));
  assert.ok(warning.includes("ERROR: complexity=20"));
  assert.ok(warning.includes("WARNING: rloc=9"));
});
