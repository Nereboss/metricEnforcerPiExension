import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMetricEnforcerConfig } from "../extensions/metric-enforcer/config/loader.ts";

test("loadMetricEnforcerConfig creates project config from bundled default when missing", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-loader-create-test-"));

  try {
    process.chdir(tempRepo);

    const loaded = await loadMetricEnforcerConfig();

    const expectedProjectConfigPath = join(tempRepo, ".pi", "metricEnforcer", "metric-enforcer.config.json");
    const bundledConfigPath = join(previousCwd, "metric-enforcer.config.json");

    const [projectConfigRaw, bundledConfigRaw] = await Promise.all([
      readFile(expectedProjectConfigPath, "utf8"),
      readFile(bundledConfigPath, "utf8"),
    ]);

    const [normalizedLoadedSourcePath, normalizedExpectedProjectConfigPath] = await Promise.all([
      realpath(loaded.sourcePath),
      realpath(expectedProjectConfigPath),
    ]);

    assert.equal(normalizedLoadedSourcePath, normalizedExpectedProjectConfigPath);
    assert.equal(projectConfigRaw, bundledConfigRaw);
    assert.ok(loaded.warnings.some((warning) => warning.includes("Created a default config")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("loadMetricEnforcerConfig uses existing project config without overwriting it", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-loader-existing-test-"));

  try {
    process.chdir(tempRepo);

    const projectConfigPath = join(tempRepo, ".pi", "metricEnforcer", "metric-enforcer.config.json");

    await mkdir(join(tempRepo, ".pi", "metricEnforcer"), { recursive: true });
    await writeFile(
      projectConfigPath,
      JSON.stringify(
        {
          logLevel: "error",
          analyzers: {
            ccsh: {
              enabled: false,
            },
          },
          thresholds: {
            global: {
              complexity: { warning: 10 },
            },
            filePatterns: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const loaded = await loadMetricEnforcerConfig();

    const [normalizedLoadedSourcePath, normalizedProjectConfigPath] = await Promise.all([
      realpath(loaded.sourcePath),
      realpath(projectConfigPath),
    ]);

    assert.equal(normalizedLoadedSourcePath, normalizedProjectConfigPath);
    assert.equal(loaded.config.logLevel, "error");
    assert.equal(loaded.warnings.some((warning) => warning.includes("Created a default config")), false);
  } finally {
    process.chdir(previousCwd);
  }
});
