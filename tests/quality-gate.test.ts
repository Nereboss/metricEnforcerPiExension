import test from "node:test";
import assert from "node:assert/strict";
import { formatMetricDefinitionsSection } from "../extensions/metric-enforcer/quality-gate.ts";

test("formatMetricDefinitionsSection lists defined metrics sorted alphabetically", () => {
  const section = formatMetricDefinitionsSection({
    rloc: "Real lines of code in the file.",
    complexity: "Cyclomatic complexity score of the file.",
  });

  assert.ok(section !== undefined);
  assert.ok(section.includes("Metric definitions (referenced by the MetricEnforcer violation messages):"));
  const complexityIndex = section.indexOf("- complexity:");
  const rlocIndex = section.indexOf("- rloc:");
  assert.ok(complexityIndex >= 0 && rlocIndex >= 0);
  assert.ok(complexityIndex < rlocIndex);
});

test("formatMetricDefinitionsSection skips metrics without a definition", () => {
  const section = formatMetricDefinitionsSection({
    complexity: "Cyclomatic complexity score of the file.",
    rloc: "   ",
  });

  assert.ok(section !== undefined);
  assert.ok(section.includes("- complexity:"));
  assert.ok(!section.includes("rloc"));
});

test("formatMetricDefinitionsSection returns undefined when nothing is defined", () => {
  assert.equal(formatMetricDefinitionsSection({}), undefined);
  assert.equal(formatMetricDefinitionsSection({ complexity: "" }), undefined);
});
