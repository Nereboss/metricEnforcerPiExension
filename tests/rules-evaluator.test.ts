import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAnalyzerResults } from "../extensions/metric-enforcer/rules/evaluator.ts";

test("rules evaluator emits warning/error and ignores -1 thresholds", () => {
  const violations = evaluateAnalyzerResults(
    [
      {
        analyzer: "ccsh",
        files: [
          {
            filePath: "src/a.ts",
            metrics: {
              complexity: 16,
              rloc: 999,
            },
          },
        ],
      },
    ],
    {
      global: {
        complexity: { warning: 10, error: 15 },
        rloc: { warning: -1 },
      },
      filePatterns: {},
    },
  );

  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    filePath: "src/a.ts",
    metric: "complexity",
    actual: 16,
    threshold: 15,
    severity: "error",
  });
});

test("rules evaluator applies file-pattern override while keeping unspecified global thresholds", () => {
  const violations = evaluateAnalyzerResults(
    [
      {
        analyzer: "ccsh",
        files: [
          {
            filePath: "src/a.ts",
            metrics: { complexity: 16 },
          },
        ],
      },
    ],
    {
      global: {
        complexity: { warning: 10, error: 15 },
      },
      filePatterns: {
        "*.ts": {
          complexity: { error: 20 },
        },
      },
    },
  );

  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    filePath: "src/a.ts",
    metric: "complexity",
    actual: 16,
    threshold: 10,
    severity: "warning",
  });
});
