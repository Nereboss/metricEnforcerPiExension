import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ccshAnalyzerPlugin, parseCcshUnifiedParserJson } from "../extensions/metric-enforcer/analyzers/ccsh-analyzer.ts";
import type { MetricEnforcerConfig } from "../extensions/metric-enforcer/config/types.ts";

const execFileAsync = promisify(execFile);

const sampleCcshUnifiedParserJson = JSON.stringify({
  data: {
    nodes: [
      {
        name: "root",
        type: "Folder",
        children: [
          {
            name: "extensions",
            type: "Folder",
            children: [
              {
                name: "metric-enforcer.ts",
                type: "File",
                attributes: {
                  complexity: 35,
                  rloc: 108,
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

test("ccsh parser maps unifiedparser JSON into normalized file metrics", () => {
  const result = parseCcshUnifiedParserJson(sampleCcshUnifiedParserJson);

  assert.equal(result.analyzer, "ccsh");
  assert.equal(result.files.length, 1);
  assert.deepEqual(result.files[0], {
    filePath: "extensions/metric-enforcer.ts",
    metrics: {
      complexity: 35,
      rloc: 108,
    },
  });
});

test("ccsh analyzer executes unifiedparser command and returns normalized result", async () => {
  let observedCommand = "";
  let observedArgs: readonly string[] = [];

  const config: MetricEnforcerConfig = {
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh-bin",
        args: ["unifiedparser", "--verbose", "$FILES"],
      },
    },
    thresholds: {
      global: {},
      filePatterns: {},
    },
  };

  const result = await ccshAnalyzerPlugin.analyze(["."], config, {
    execFile: async (command, args) => {
      observedCommand = command;
      observedArgs = args;
      return { stdout: sampleCcshUnifiedParserJson, stderr: "" };
    },
    cwd: process.cwd(),
  });

  assert.equal(observedCommand, "ccsh-bin");
  assert.deepEqual(observedArgs, ["unifiedparser", "--verbose", "."]);
  assert.equal(result.analyzer, "ccsh");
  assert.equal(result.files.length, 1);
});

test("ccsh analyzer can run real ccsh unifiedparser command when ccsh is available", async (t) => {
  if (!(await isCcshAvailable())) {
    t.skip("ccsh is not available in PATH for this environment");
    return;
  }

  const projectDir = await mkdtemp(join(tmpdir(), "metric-enforcer-ccsh-"));
  await writeFile(join(projectDir, "index.ts"), "export const value = 1;\n", "utf8");

  const config: MetricEnforcerConfig = {
    analyzers: {
      ccsh: {
        enabled: true,
        command: "ccsh",
        args: ["unifiedparser", "."],
      },
    },
    thresholds: {
      global: {},
      filePatterns: {},
    },
  };

  const result = await ccshAnalyzerPlugin.analyze(["index.ts"], config, {
    execFile: async (command, args, cwd) =>
      execFileAsync(command, [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      }),
    cwd: projectDir,
  });

  assert.equal(result.analyzer, "ccsh");
  assert.ok(result.files.some((entry) => entry.filePath.endsWith("index.ts")));
});

async function isCcshAvailable(): Promise<boolean> {
  try {
    await execFileAsync("ccsh", ["--help"], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}
