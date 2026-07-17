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

test("formatBackpressureMessage lists violations grouped by file with directional bounds", () => {
  const message = formatBackpressureMessage(violations);

  assert.ok(message.includes("- src/a.ts"));
  assert.ok(message.includes("ERROR complexity 20 (max 15)"));
  assert.ok(message.includes("WARNING rloc 9 (max 8)"));
});

test("formatBackpressureMessage omits static guidance and definitions now carried by the system prompt", () => {
  const message = formatBackpressureMessage(violations);

  assert.ok(!message.includes("Metric definitions:"));
  assert.ok(!message.includes("Follow these instructions"));
  assert.ok(!message.includes("not part of the main conversation"));
});

test("formatRetriesExhaustedWarning contains unresolved violations in file/metric message format", () => {
  const warning = formatRetriesExhaustedWarning(violations, 3);

  assert.ok(warning.includes("after 3 allowed backpressure retries"));
  assert.ok(warning.includes("- src/a.ts"));
  assert.ok(warning.includes("ERROR complexity 20 (max 15)"));
  assert.ok(warning.includes("WARNING rloc 9 (max 8)"));
});
