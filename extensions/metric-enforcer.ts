import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { loadMetricEnforcerConfig } from "./metric-enforcer/config/loader.js";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/agent-end.sh", import.meta.url));
const MISSING_FILE_HASH = "__MISSING__";

let baselineSnapshot = new Map<string, string>();

function parseLines(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function runGit(args: string[]) {
  return execFileAsync("git", args, { encoding: "utf8" });
}

async function getWorkingTreeSnapshot(): Promise<Map<string, string>> {
  const { stdout } = await runGit(["ls-files", "-co", "--exclude-standard"]);
  const files = parseLines(stdout).sort((a, b) => a.localeCompare(b));

  const entries = await Promise.all(
    files.map(async (filePath) => {
      try {
        const { stdout: hash } = await runGit(["hash-object", "--", filePath]);
        return [filePath, hash.trim()] as const;
      } catch {
        return [filePath, MISSING_FILE_HASH] as const;
      }
    }),
  );

  return new Map(entries);
}

function getChangedFilesBetweenSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const allFiles = new Set<string>([...before.keys(), ...after.keys()]);

  return [...allFiles]
    .filter((file) => before.get(file) !== after.get(file))
    .sort((a, b) => a.localeCompare(b));
}

function formatMessageForTouchedFiles(files: string[]): string {
  if (files.length === 0) {
    return "Agent changed no files.";
  }

  return `Agent changed files:\n${files.join("\n")}`;
}

function showConfigWarnings(ctx: any, warning?: string) {
  if (warning === undefined) return 

  if (ctx.hasUI) {
    ctx.ui.notify(warning, "warning");
  }
  console.warn(warning);
}

function getEnabledAnalyzers(config: any): string[] {
  return Object.entries(config.analyzers)
    .filter(([, analyzerConfig]: any) => analyzerConfig.enabled)
    .map(([analyzerName]) => analyzerName)
    .sort((a, b) => a.localeCompare(b));
}

export default function metricEnforcer(pi: ExtensionAPI) {
  pi.on("agent_start", async (_event, ctx) => {
    try {
      await runGit(["rev-parse", "--is-inside-work-tree"]);
      baselineSnapshot = await getWorkingTreeSnapshot();
    } catch (error) {
      baselineSnapshot = new Map<string, string>();
      const message = `Could not capture git baseline: ${error instanceof Error ? error.message : String(error)}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      console.error(`[metric-enforcer] ${message}`);
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    try {
      const endSnapshot = await getWorkingTreeSnapshot();
      const changedByAgent = getChangedFilesBetweenSnapshots(baselineSnapshot, endSnapshot);
      const touchedFilesMessage = formatMessageForTouchedFiles(changedByAgent);

      if (ctx.hasUI) {
        ctx.ui.notify(touchedFilesMessage, "info");
      }

      const loadedConfig = await loadMetricEnforcerConfig();
      const { config, warning, sourcePath } = loadedConfig;

      showConfigWarnings(ctx, warning)

      const enabledAnalyzers = getEnabledAnalyzers(config)

      if (ctx.hasUI) {
        ctx.ui.notify(
          enabledAnalyzers.length === 0
            ? `Metric config loaded from ${sourcePath}. No analyzers enabled.`
            : `Metric config loaded from ${sourcePath}. Enabled analyzers: ${enabledAnalyzers.join(", ")}`,
          "info",
        );
      }

      const { stdout, stderr } = await execFileAsync("bash", [scriptPath]);
      const scriptOutput = stdout.trim() || stderr.trim() || "(script returned no output)";

      if (ctx.hasUI) {
        ctx.ui.notify(`Script output: ${scriptOutput}`, "info");
      }
    } catch (error) {
      const message = `Agent loop ended, but pre-check/script failed: ${error instanceof Error ? error.message : String(error)}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      console.error(`[metric-enforcer] ${message}`);
    } finally {
      baselineSnapshot = new Map<string, string>();
    }
  });
}
