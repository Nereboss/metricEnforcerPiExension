import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL("../scripts/agent-end.sh", import.meta.url));

export default function helloAgentEndExtension(pi: ExtensionAPI) {
  pi.on("agent_end", async (_event, ctx) => {
    try {
      const { stdout, stderr } = await execFileAsync("bash", [scriptPath]);
      const scriptOutput = stdout.trim() || stderr.trim() || "(script returned no output)";
      const message = `Agent loop ended: ${scriptOutput}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "info");
      }

      console.log(`[hello-agent-end] ${message}`);
    } catch (error) {
      const message = `Agent loop ended, but script failed: ${error instanceof Error ? error.message : String(error)}`;

      if (ctx.hasUI) {
        ctx.ui.notify(message, "error");
      }

      console.error(`[hello-agent-end] ${message}`);
    }
  });
}
