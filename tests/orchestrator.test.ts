import test from "node:test";
import assert from "node:assert/strict";
import { runMetricOrchestration } from "../extensions/metric-enforcer/orchestrator.ts";
import type { MetricEnforcerConfig } from "../extensions/metric-enforcer/config/types.ts";

const sampleCcshUnifiedParserJson = JSON.stringify({
  data: {
    nodes: [
      {
        name: "root",
        type: "Folder",
        children: [
          {
            name: "src",
            type: "Folder",
            children: [
              {
                name: "a.ts",
                type: "File",
                attributes: {
                  complexity: 12,
                },
                children: [],
              },
            ],
          },
        ],
      },
    ],
  },
});

test("orchestrator runs enabled ccsh analyzer and produces violations", async () => {
  const config: MetricEnforcerConfig = {
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh",
        args: ["unifiedparser", "$FILES"],
      },
    },
    thresholds: {
      global: {
        complexity: { warning: 1, error: 2 },
      },
      filePatterns: {},
    },
  };

  const result = await runMetricOrchestration(["."], config, {
    execFile: async () => ({ stdout: sampleCcshUnifiedParserJson, stderr: "" }),
    cwd: process.cwd(),
  });

  assert.deepEqual(result.enabledAnalyzers, ["ccsh"]);
  assert.equal(result.analyzerResults.length, 1);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].severity, "error");
  assert.deepEqual(result.analyzerWarnings, []);
});

test("orchestrator skips analyzer when executable is missing", async () => {
  const config: MetricEnforcerConfig = {
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh",
        args: ["unifiedparser", "$FILES"],
      },
    },
    thresholds: {
      global: {
        complexity: { warning: 1 },
      },
      filePatterns: {},
    },
  };

  const result = await runMetricOrchestration(["."], config, {
    execFile: async () => {
      const error = new Error("spawn ccsh ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      error.path = "ccsh";
      throw error;
    },
    cwd: process.cwd(),
  });

  assert.deepEqual(result.analyzerResults, []);
  assert.deepEqual(result.violations, []);
  assert.equal(result.analyzerWarnings.length, 1);
  assert.ok(result.analyzerWarnings[0].includes('Analyzer "ccsh" skipped'));
});

test("orchestrator skips disabled analyzers", async () => {
  const config: MetricEnforcerConfig = {
    analyzers: {
      ccsh: {
        enabled: false,
      },
    },
    thresholds: {
      global: {
        complexity: { warning: 1 },
      },
      filePatterns: {},
    },
  };

  const result = await runMetricOrchestration(["."], config, {
    execFile: async () => {
      throw new Error("should not be called");
    },
    cwd: process.cwd(),
  });

  assert.deepEqual(result.enabledAnalyzers, []);
  assert.deepEqual(result.analyzerResults, []);
  assert.deepEqual(result.violations, []);
});
