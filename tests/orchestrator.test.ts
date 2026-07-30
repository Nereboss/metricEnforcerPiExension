import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { collectMetricDefinitions, runMetricOrchestration } from "../extensions/metric-enforcer/orchestrator.ts";
import type { MetricEnforcerConfig } from "../extensions/metric-enforcer/config/types.ts";

function makeConfig(overrides: Partial<MetricEnforcerConfig> = {}): MetricEnforcerConfig {
  return {
    logLevel: "warning",
    analyzers: { ccsh: { enabled: true, command: "ccsh", args: [] } },
    thresholds: { global: {}, filePatterns: {} },
    backpressure: { errorOnly: false, maxBackpressureRetries: 3 },
    metricDefinitions: {},
    ...overrides,
  };
}

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

const defaultBackpressure = {
  errorOnly: false,
  maxBackpressureRetries: 3,
} as const;

test("orchestrator runs enabled ccsh analyzer and produces violations", async () => {
  const config: MetricEnforcerConfig = {
    logLevel: "warning",
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh",
        args: ["unifiedparser", ".", "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json"],
      },
    },
    thresholds: {
      global: {
        complexity: { warning: 1, error: 2 },
      },
      filePatterns: {},
    },
    backpressure: defaultBackpressure,
  };

  const result = await runMetricOrchestration(["."], config, {
    execFile: async (_command, args, cwd) => {
      const outputFileArg = args.find((arg) => arg.startsWith("--output-file="));
      assert.ok(outputFileArg);
      const outputFilePath = outputFileArg.replace("--output-file=", "");
      await writeFile(join(cwd ?? process.cwd(), outputFilePath), sampleCcshUnifiedParserJson, "utf8");
      return { stdout: "", stderr: "" };
    },
    cwd: process.cwd(),
  });

  assert.deepEqual(result.enabledAnalyzers, ["ccsh"]);
  assert.equal(result.analyzerResults.length, 0);
  assert.equal(result.violations.length, 0);
  assert.deepEqual(result.analyzerWarnings, []);
});

test("orchestrator reports violations only for touched files", async () => {
  const config: MetricEnforcerConfig = {
    logLevel: "warning",
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh",
        args: ["unifiedparser", ".", "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json"],
      },
    },
    thresholds: {
      global: {
        complexity: { warning: 1, error: 2 },
      },
      filePatterns: {},
    },
    backpressure: defaultBackpressure,
  };

  const result = await runMetricOrchestration(["src/a.ts"], config, {
    execFile: async (_command, args, cwd) => {
      const outputFileArg = args.find((arg) => arg.startsWith("--output-file="));
      assert.ok(outputFileArg);
      const outputFilePath = outputFileArg.replace("--output-file=", "");
      await writeFile(
        join(cwd ?? process.cwd(), outputFilePath),
        JSON.stringify({
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
                        attributes: { complexity: 12 },
                        children: [],
                      },
                      {
                        name: "b.ts",
                        type: "File",
                        attributes: { complexity: 20 },
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
        "utf8",
      );
      return { stdout: "", stderr: "" };
    },
    cwd: process.cwd(),
  });

  assert.equal(result.analyzerResults.length, 1);
  assert.equal(result.analyzerResults[0].files.length, 1);
  assert.equal(result.analyzerResults[0].files[0].filePath, "src/a.ts");
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].filePath, "src/a.ts");
});

test("orchestrator skips analyzer when executable is missing", async () => {
  const config: MetricEnforcerConfig = {
    logLevel: "warning",
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh",
        args: ["unifiedparser", ".", "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json"],
      },
    },
    thresholds: {
      global: {
        complexity: { warning: 1 },
      },
      filePatterns: {},
    },
    backpressure: defaultBackpressure,
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
    logLevel: "warning",
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
    backpressure: defaultBackpressure,
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

test("collectMetricDefinitions returns definitions from the enabled ccsh analyzer", () => {
  const { definitions, warnings } = collectMetricDefinitions(makeConfig());

  assert.equal(warnings.length, 0);
  assert.ok(definitions.complexity.length > 0);
  assert.ok(definitions.logic_complexity.length > 0);
  assert.ok(definitions.rloc.length > 0);
});

test("collectMetricDefinitions omits definitions when the analyzer is disabled", () => {
  const { definitions } = collectMetricDefinitions(
    makeConfig({ analyzers: { ccsh: { enabled: false, command: "ccsh", args: [] } } }),
  );

  assert.deepEqual(definitions, {});
});

test("collectMetricDefinitions lets config override an analyzer definition", () => {
  const { definitions } = collectMetricDefinitions(
    makeConfig({ metricDefinitions: { complexity: "Custom wording.", extra: "A config-only metric." } }),
  );

  assert.equal(definitions.complexity, "Custom wording.");
  assert.equal(definitions.extra, "A config-only metric.");
});
