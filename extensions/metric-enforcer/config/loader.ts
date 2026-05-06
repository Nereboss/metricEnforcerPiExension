import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { MetricEnforcerConfig } from "./types.ts";
import { validateMetricEnforcerConfig } from "./validate-config.ts";
import { getErrorCode } from "../utils.ts";

const DEFAULT_CONFIG_FILE_NAME = "metric-enforcer.config.json";
const BUNDLED_DEFAULT_CONFIG_RELATIVE_PATH = "../../../metric-enforcer.config.json";

export interface LoadedMetricEnforcerConfig {
  config: MetricEnforcerConfig;
  sourcePath: string;
  warning?: string;
}

export async function loadMetricEnforcerConfig(
  cwd: string = process.cwd(),
  configFileName: string = DEFAULT_CONFIG_FILE_NAME,
): Promise<LoadedMetricEnforcerConfig> {
  const projectConfigPath = join(cwd, ".pi", "metricEnforcer", configFileName);
  const projectConfig = await readConfigIfExists(projectConfigPath);

  if (projectConfig !== undefined) {
    return {
      config: parseAndValidateConfig(projectConfigPath, projectConfig),
      sourcePath: projectConfigPath,
    };
  }

  const bundledConfigPath = fileURLToPath(new URL(BUNDLED_DEFAULT_CONFIG_RELATIVE_PATH, import.meta.url));
  const bundledConfig = await readConfigRequired(bundledConfigPath);

  return {
    config: parseAndValidateConfig(bundledConfigPath, bundledConfig),
    sourcePath: bundledConfigPath,
    warning: `[metric-enforcer] No ${configFileName} found at ${projectConfigPath}. Using bundled default config from extension repository.`,
  };
}

function parseAndValidateConfig(configPath: string, rawConfig: string): MetricEnforcerConfig {
  let parsedConfig: unknown;

  try {
    parsedConfig = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    throw new Error(
      `[metric-enforcer] Invalid JSON in ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return validateMetricEnforcerConfig(parsedConfig, configPath);
}

async function readConfigIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }

    throw new Error(
      `[metric-enforcer] Could not read config file at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readConfigRequired(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `[metric-enforcer] Could not read bundled default config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return getErrorCode(error) === "ENOENT";
}


export { DEFAULT_CONFIG_FILE_NAME };
