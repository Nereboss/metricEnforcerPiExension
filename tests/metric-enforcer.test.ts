import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type, type Static, type TSchema } from "typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import metricEnforcer from "../extensions/metric-enforcer.ts";

const execFileAsync = promisify(execFile);

interface RegisteredTool<TParameters extends TSchema = TSchema> {
  name: string;
  parameters: TParameters;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: TestContext,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

interface SentCustomMessage {
  message: {
    customType: string;
    content: string;
    display?: boolean;
  };
  options?: {
    triggerTurn?: boolean;
    deliverAs?: string;
  };
}

class FakePi {
  private handlers = new Map<string, Array<(event: unknown, ctx: TestContext) => Promise<unknown> | unknown>>();
  private commands = new Map<string, (args: string, ctx: TestContext) => Promise<void>>();
  private tools = new Map<string, RegisteredTool>();
  private userMessages: string[] = [];
  private customMessages: SentCustomMessage[] = [];

  on(eventName: string, handler: (event: unknown, ctx: TestContext) => Promise<unknown> | unknown): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }

  registerCommand(_name: string, options: { handler: (args: string, ctx: TestContext) => Promise<void> }): void {
    this.commands.set(_name, options.handler);
  }

  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  async emit(eventName: string, ctx: TestContext, event: Record<string, unknown> = {}): Promise<unknown[]> {
    const eventHandlers = this.handlers.get(eventName) ?? [];
    const results: unknown[] = [];

    for (const handler of eventHandlers) {
      results.push(await handler(event, ctx));
    }

    return results;
  }

  async invokeCommand(name: string, args: string, ctx: TestContext): Promise<void> {
    const handler = this.commands.get(name);

    if (handler === undefined) {
      throw new Error(`Missing command handler for: ${name}`);
    }

    await handler(args, ctx);
  }

  async invokeTool(name: string, params: Record<string, unknown>, ctx: TestContext) {
    const tool = this.tools.get(name);

    if (tool === undefined) throw new Error(`Missing registered tool: ${name}`);

    return tool.execute("test-tool-call", params as never, undefined, undefined, ctx);
  }

  hasRegisteredTool(name: string): boolean {
    return this.tools.has(name);
  }

  sendUserMessage(content: string): void {
    this.userMessages.push(content);
  }

  sendMessage(message: SentCustomMessage["message"], options?: SentCustomMessage["options"]): void {
    this.customMessages.push({ message, options });
  }

  getSentUserMessages(): string[] {
    return [...this.userMessages];
  }

  getSentCustomMessages(): SentCustomMessage[] {
    return [...this.customMessages];
  }

  getRegisteredEventNames(): string[] {
    return [...this.handlers.keys()].sort((a, b) => a.localeCompare(b));
  }
}

interface Notification {
  message: string;
  level: string;
}

interface TestContext {
  hasUI: boolean;
  signal?: AbortSignal;
  ui: {
    notify(message: string, level: string): void;
  };
}

test("metric-enforcer registers expected lifecycle handlers", () => {
  const fakePi = new FakePi();
  metricEnforcer(fakePi as never);

  assert.deepEqual(fakePi.getRegisteredEventNames(), [
    "agent_end",
    "agent_start",
    "before_agent_start",
    "context",
    "input",
    "session_start",
  ]);
});

test("metric-enforcer registers the temporary file-waiver tool", () => {
  const fakePi = new FakePi();
  metricEnforcer(fakePi as never);

  assert.equal(fakePi.hasRegisteredTool("waive_metric_file"), true);
});

test("metric-enforcer shows a single error in a non-git directory and then stays silent", async () => {
  const previousCwd = process.cwd();
  const tempDir = await mkdtemp(join(tmpdir(), "metric-enforcer-non-git-test-"));

  try {
    process.chdir(tempDir);

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("session_start", ctx, { reason: "startup" });

    // The load-time notice is a single error so the user knows it is inactive.
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].level, "error");
    assert.ok(notifications[0].message.includes("not a git repository"));

    // Subsequent events must stay silent instead of throwing fatal git errors.
    await fakePi.emit("before_agent_start", ctx, { systemPrompt: "BASE_PROMPT" });
    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.equal(notifications.length, 1);

    // The activate command surfaces the same error so the user is reminded.
    await fakePi.invokeCommand("activateMetricEnforcer", "", ctx);

    assert.equal(notifications.length, 2);
    assert.equal(notifications[1].level, "error");
    assert.ok(notifications[1].message.includes("not a git repository"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer appends quality-gate policy from the extension repository", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-policy-test-"));

  try {
    process.chdir(tempRepo);

    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify() {
          // noop
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    const [beforeAgentStartResult] = await fakePi.emit("before_agent_start", ctx, { systemPrompt: "BASE_PROMPT" });

    assert.equal(typeof beforeAgentStartResult, "object");
    assert.ok(
      (beforeAgentStartResult as { systemPrompt: string }).systemPrompt.includes(
        "come from an extension judging code quality.",
      ),
    );
    assert.ok(
      (beforeAgentStartResult as { systemPrompt: string }).systemPrompt.includes(
        "Do not waive violations introduced or materially affected by your changes.",
      ),
    );
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer ignores quality policy files from the user project cwd", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-cwd-policy-test-"));

  try {
    process.chdir(tempRepo);
    await writeFile(
      "metric-enforcer-quality-gate-policy.md",
      "# User project policy\n- NEVER USE THIS POLICY FROM CWD",
      "utf8",
    );

    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify() {
          // noop
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    const [beforeAgentStartResult] = await fakePi.emit("before_agent_start", ctx, { systemPrompt: "BASE_PROMPT" });
    const systemPrompt = (beforeAgentStartResult as { systemPrompt: string }).systemPrompt;

    assert.equal(systemPrompt.includes("NEVER USE THIS POLICY FROM CWD"), false);
    assert.ok(systemPrompt.includes("continue the current user objective"));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer context hook uses current-cycle tracking to prune quality-gate messages", async () => {
  const ctx: TestContext = {
    hasUI: true,
    ui: {
      notify() {
        // noop
      },
    },
  };

  const fakePi = new FakePi();
  metricEnforcer(fakePi as never);

  const [contextWithoutCurrentCycleQualityMessages] = await fakePi.emit("context", ctx, {
    messages: [
      { role: "custom", customType: "MetricEnforcer", content: "old gate 1" },
      { role: "assistant", content: "assistant output" },
      { role: "custom", customType: "MetricEnforcer", content: "old gate 2" },
    ],
  });

  const prunedWithoutCurrentCycle = (
    contextWithoutCurrentCycleQualityMessages as { messages: Array<{ content?: string; role: string }> }
  ).messages;

  assert.equal(prunedWithoutCurrentCycle.some((message) => message.role === "custom"), false);
});

test("deactivateMetricEnforcer disables metric checks until reactivated", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-toggle-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "info",
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

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.invokeCommand("deactivateMetricEnforcer", "", ctx);
    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    const deactivatedMessages = notifications.map((entry) => entry.message);
    assert.equal(deactivatedMessages.some((message) => message.includes("Metric checks passed.")), false);

    notifications.length = 0;

    await fakePi.invokeCommand("activateMetricEnforcer", "", ctx);
    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 3;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    const reactivatedMessages = notifications.map((entry) => entry.message);
    assert.ok(reactivatedMessages.some((message) => message.includes("Metric checks passed.")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer respects logLevel and hides info messages when set to error", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-log-level-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
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

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.equal(notifications.length, 0);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer falls back to warning logLevel when config logLevel is invalid", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-invalid-log-level-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "verbose",
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

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.ok(
      notifications.some((entry) =>
        entry.message.includes('Invalid "logLevel"') && entry.message.includes('Falling back to "warning"'),
      ),
    );
    assert.equal(notifications.some((entry) => entry.message.includes("Agent changed files:")), false);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer skips backpressure when the agent run is aborted", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-aborted-run-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1);

    const abortController = new AbortController();
    const ctx: TestContext = { hasUI: true, signal: abortController.signal, ui: { notify() {} } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    abortController.abort();
    await fakePi.emit("agent_end", ctx);

    assert.equal(fakePi.getSentCustomMessages().length, 0);
    assert.equal(await countAnalyzerAttemptsIfPresent(), 0);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer does not emit backpressure when the run is aborted during analysis", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-aborted-analysis-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1, 100);

    const abortController = new AbortController();
    const ctx: TestContext = { hasUI: true, signal: abortController.signal, ui: { notify() {} } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    const agentEnd = fakePi.emit("agent_end", ctx);
    await waitForAnalyzerAttempt();
    abortController.abort();
    await agentEnd;

    assert.equal(fakePi.getSentCustomMessages().length, 0);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer sends warning backpressure as quality-gate custom message", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-warning-backpressure-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "info",
          analyzers: {
            ccsh: {
              enabled: true,
              command: "node",
              args: [
                "-e",
                "const fs=require('fs');const arg=process.argv.find((value)=>value.startsWith('--output-file='));const out=arg.split('=')[1];fs.mkdirSync('.pi/metricEnforcer',{recursive:true});fs.writeFileSync(out,JSON.stringify({data:{nodes:[{name:'root',type:'Folder',children:[{name:'sample.ts',type:'File',attributes:{complexity:11},children:[]}]}]}}));",
                "--",
                "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json",
              ],
            },
          },
          backpressure: {
            errorOnly: false,
            maxBackpressureRetries: 3,
          },
          thresholds: {
            global: {
              complexity: { warning: 10, error: 15 },
            },
            filePatterns: {},
          },
          metricDefinitions: {
            complexity: "Cyclomatic complexity score of the touched file.",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    const sentCustomMessages = fakePi.getSentCustomMessages();
    assert.equal(sentCustomMessages.length, 1);
    assert.equal(sentCustomMessages[0].message.customType, "MetricEnforcer");
    assert.equal(sentCustomMessages[0].options?.deliverAs, "steer");
    assert.equal(sentCustomMessages[0].options?.triggerTurn, true);
    assert.ok(sentCustomMessages[0].message.content.includes("WARNING complexity 11 (max 10)"));
    // The message carries only the changing violation data; definitions and static guidance now live
    // once in the system-prompt policy, so they must not be repeated here.
    assert.ok(!sentCustomMessages[0].message.content.includes("Metric definitions:"));
    assert.ok(!sentCustomMessages[0].message.content.includes("Follow these instructions"));
    assert.equal(fakePi.getSentUserMessages().length, 0);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer waives only a tracked existing project-relative file", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-waiver-tool-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1);

    const ctx: TestContext = { hasUI: true, ui: { notify() {} } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    const untrackedResult = await fakePi.invokeTool("waive_metric_file", { filePath: "other.ts" }, ctx);
    assert.equal(untrackedResult.isError, true);
    assert.match(untrackedResult.content[0].text, /not changed by the agent/);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    const absoluteResult = await fakePi.invokeTool("waive_metric_file", { filePath: join(tempRepo, "sample.ts") }, ctx);
    const traversalResult = await fakePi.invokeTool("waive_metric_file", { filePath: "../outside.ts" }, ctx);
    const missingResult = await fakePi.invokeTool("waive_metric_file", { filePath: "missing.ts" }, ctx);
    const acceptedResult = await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts", reason: "legacy" }, ctx);

    assert.equal(absoluteResult.isError, true);
    assert.equal(traversalResult.isError, true);
    assert.equal(missingResult.isError, true);
    assert.equal(acceptedResult.isError, false);
    assert.match(acceptedResult.content[0].text, /checked again automatically if its contents change/);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer skips an all-waived cycle without analysis or a successful-check notification", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-all-waived-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1);

    const notifications: Notification[] = [];
    const ctx: TestContext = { hasUI: true, ui: { notify(message, level) { notifications.push({ message, level }); } } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    assert.equal(await countAnalyzerAttempts(), 1);
    assert.equal(fakePi.getSentCustomMessages().length, 1);

    await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts" }, ctx);
    notifications.length = 0;
    await fakePi.emit("agent_start", ctx);
    await fakePi.emit("agent_end", ctx);

    assert.equal(await countAnalyzerAttempts(), 1);
    assert.equal(fakePi.getSentCustomMessages().length, 1);
    assert.equal(notifications.some((entry) => entry.message.includes("Metric checks passed.")), false);
    assert.ok(notifications.some((entry) => entry.message.includes("skipped 1 waived file")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer keeps backpressure for a non-waived file", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-partial-waiver-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFile("other.ts", "export const y = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1);

    const ctx: TestContext = { hasUI: true, ui: { notify() {} } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await writeFile("other.ts", "export const y = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    await fakePi.invokeTool("waive_metric_file", { filePath: "other.ts" }, ctx);

    await fakePi.emit("agent_start", ctx);
    await fakePi.emit("agent_end", ctx);

    assert.equal(fakePi.getSentCustomMessages().length, 2);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer clears waivers at user-cycle and deactivation boundaries", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-waiver-reset-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1);

    const ctx: TestContext = { hasUI: true, ui: { notify() {} } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts" }, ctx);
    await fakePi.emit("input", ctx, { source: "interactive" });
    await fakePi.emit("agent_start", ctx);
    const afterUserReset = await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts" }, ctx);
    assert.equal(afterUserReset.isError, true);

    await writeFile("sample.ts", "export const x = 3;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts" }, ctx);
    await fakePi.invokeCommand("deactivateMetricEnforcer", "", ctx);
    await fakePi.invokeCommand("activateMetricEnforcer", "", ctx);
    const afterDeactivationReset = await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts" }, ctx);
    assert.equal(afterDeactivationReset.isError, true);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer revokes a waiver and resumes backpressure when the file changes", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-waiver-revocation-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(1);

    const notifications: Notification[] = [];
    const ctx: TestContext = { hasUI: true, ui: { notify(message, level) { notifications.push({ message, level }); } } };
    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    await fakePi.invokeTool("waive_metric_file", { filePath: "sample.ts" }, ctx);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 3;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.equal(fakePi.getSentCustomMessages().length, 2);
    assert.ok(notifications.some((entry) => entry.message.includes("resumed checking sample.ts")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer stops backpressure when max retries are exhausted", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-retry-exhausted-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "info",
          analyzers: {
            ccsh: {
              enabled: true,
              command: "node",
              args: [
                "-e",
                "const fs=require('fs');const arg=process.argv.find((value)=>value.startsWith('--output-file='));const out=arg.split('=')[1];fs.mkdirSync('.pi/metricEnforcer',{recursive:true});fs.writeFileSync(out,JSON.stringify({data:{nodes:[{name:'root',type:'Folder',children:[{name:'sample.ts',type:'File',attributes:{complexity:99},children:[]}]}]}}));",
                "--",
                "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json",
              ],
            },
          },
          backpressure: {
            errorOnly: false,
            maxBackpressureRetries: 1,
          },
          thresholds: {
            global: {
              complexity: { warning: 10, error: 15 },
            },
            filePatterns: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    assert.equal(fakePi.getSentCustomMessages().length, 1);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 3;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.equal(fakePi.getSentCustomMessages().length, 1);
    assert.ok(notifications.some((entry) => entry.message.includes("could not fix")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer keeps checking files touched in earlier turns during backpressure retries", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-cross-turn-backpressure-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "info",
          analyzers: {
            ccsh: {
              enabled: true,
              command: "node",
              args: [
                "-e",
                "const fs=require('fs');const arg=process.argv.find((value)=>value.startsWith('--output-file='));const out=arg.split('=')[1];fs.mkdirSync('.pi/metricEnforcer',{recursive:true});fs.writeFileSync(out,JSON.stringify({data:{nodes:[{name:'root',type:'Folder',children:[{name:'sample.ts',type:'File',attributes:{complexity:99},children:[]}]}]}}));",
                "--",
                "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json",
              ],
            },
          },
          backpressure: {
            errorOnly: false,
            maxBackpressureRetries: 1,
          },
          thresholds: {
            global: {
              complexity: { warning: 10, error: 15 },
            },
            filePatterns: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    assert.equal(fakePi.getSentCustomMessages().length, 1);

    await fakePi.emit("agent_start", ctx);
    await fakePi.emit("agent_end", ctx);

    assert.equal(fakePi.getSentCustomMessages().length, 1);
    assert.ok(notifications.some((entry) => entry.message.includes("could not fix")));
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer resets tracked files when a real user message starts a new cycle", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-user-reset-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "info",
          analyzers: {
            ccsh: {
              enabled: true,
              command: "node",
              args: [
                "-e",
                "const fs=require('fs');const arg=process.argv.find((value)=>value.startsWith('--output-file='));const out=arg.split('=')[1];fs.mkdirSync('.pi/metricEnforcer',{recursive:true});fs.writeFileSync(out,JSON.stringify({data:{nodes:[{name:'root',type:'Folder',children:[{name:'sample.ts',type:'File',attributes:{complexity:99},children:[]}]}]}}));",
                "--",
                "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json",
              ],
            },
          },
          backpressure: {
            errorOnly: false,
            maxBackpressureRetries: 1,
          },
          thresholds: {
            global: {
              complexity: { warning: 10, error: 15 },
            },
            filePatterns: {},
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("input", ctx, { source: "interactive" });
    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);
    assert.equal(fakePi.getSentCustomMessages().length, 1);

    await fakePi.emit("input", ctx, { source: "interactive" });
    await fakePi.emit("agent_start", ctx);
    await fakePi.emit("agent_end", ctx);

    assert.equal(fakePi.getSentCustomMessages().length, 1);
    assert.equal(notifications.some((entry) => entry.message.includes("could not fix")), false);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer happy path with disabled analyzer reports successful checks", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await writeFile("sample.ts", "export const x = 1;\n", "utf8");

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "info",
          analyzers: {
            ccsh: {
              enabled: false,
              command: "ccsh",
              args: ["unifiedparser", ".", "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json"],
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

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    const messages = notifications.map((entry) => entry.message);
    assert.ok(messages.some((message) => message.includes("Agent changed files:")));
    assert.ok(messages.some((message) => message.includes("No analyzers enabled.")));
    assert.ok(messages.some((message) => message.includes("Metric checks passed.")));
  } finally {
    process.chdir(previousCwd);
  }
});

/**
 * Fake analyzer that records every invocation in `attempts.log` and fails until it has been called
 * `succeedFromAttempt` times, so tests can drive the analysis retry loop.
 */
function createFlakyAnalyzerArgs(succeedFromAttempt: number, delayMilliseconds = 0): string[] {
  const writeResult =
    "const arg=process.argv.find((value)=>value.startsWith('--output-file='));" +
    "const out=arg.split('=')[1];" +
    "fs.mkdirSync('.pi/metricEnforcer',{recursive:true});" +
    "fs.writeFileSync(out,JSON.stringify({data:{nodes:[{name:'root',type:'Folder',children:[{name:'sample.ts',type:'File',attributes:{complexity:99},children:[]}]}]}}));";
  const delayedWriteResult = delayMilliseconds === 0 ? writeResult : `setTimeout(()=>{${writeResult}},${delayMilliseconds});`;

  return [
    "-e",
    "const fs=require('fs');" +
      "fs.appendFileSync('attempts.log','x');" +
      "const attempts=fs.readFileSync('attempts.log','utf8').length;" +
      `if(attempts<${succeedFromAttempt})process.exit(1);` +
      delayedWriteResult,
    "--",
    "--output-file=.pi/metricEnforcer/cachedAnalysis.cc.json",
  ];
}

async function writeFlakyAnalyzerConfig(succeedFromAttempt: number, delayMilliseconds = 0): Promise<void> {
  await mkdir(".pi/metricEnforcer", { recursive: true });
  await writeFile(
    ".pi/metricEnforcer/metric-enforcer.config.json",
    JSON.stringify(
      {
        logLevel: "info",
        analyzers: {
          ccsh: {
            enabled: true,
            command: "node",
            args: createFlakyAnalyzerArgs(succeedFromAttempt, delayMilliseconds),
          },
        },
        backpressure: {
          errorOnly: false,
          maxBackpressureRetries: 3,
        },
        thresholds: {
          global: {
            complexity: { warning: 10, error: 15 },
          },
          filePatterns: {},
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function countAnalyzerAttempts(): Promise<number> {
  return (await readFile("attempts.log", "utf8")).length;
}

async function countAnalyzerAttemptsIfPresent(): Promise<number> {
  try {
    return await countAnalyzerAttempts();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function waitForAnalyzerAttempt(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await countAnalyzerAttemptsIfPresent()) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error("Timed out waiting for the analyzer to start.");
}

test("metric-enforcer retries a failing analysis and keeps the gate silent once it succeeds", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-analysis-retry-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(3);

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.equal(await countAnalyzerAttempts(), 3);
    // The third attempt produced violations, so the gate steers the agent as usual.
    assert.equal(fakePi.getSentCustomMessages().length, 1);
    assert.equal(notifications.some((entry) => entry.message.includes("could not be run")), false);
    assert.equal(notifications.filter((entry) => entry.message.includes("failed, retrying")).length, 2);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer reports that the analysis could not be run after three failed attempts", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-analysis-failure-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);
    await writeFile("sample.ts", "export const x = 1;\n", "utf8");
    await writeFlakyAnalyzerConfig(Number.MAX_SAFE_INTEGER);

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    await fakePi.emit("agent_start", ctx);
    await writeFile("sample.ts", "export const x = 2;\n", "utf8");
    await fakePi.emit("agent_end", ctx);

    assert.equal(await countAnalyzerAttempts(), 3);

    const failureNotifications = notifications.filter((entry) => entry.message.includes("could not be run"));
    assert.equal(failureNotifications.length, 1);
    assert.equal(failureNotifications[0].level, "error");
    assert.ok(failureNotifications[0].message.includes("no quality gate was applied to this turn"));
    // A failed analysis must never look like a passed gate.
    assert.equal(notifications.some((entry) => entry.message.includes("Metric checks passed.")), false);
    assert.equal(fakePi.getSentCustomMessages().length, 0);
  } finally {
    process.chdir(previousCwd);
  }
});

test("metric-enforcer logs a config warning once per turn instead of on every retry", async () => {
  const previousCwd = process.cwd();
  const tempRepo = await mkdtemp(join(tmpdir(), "metric-enforcer-warning-dedup-test-"));

  try {
    process.chdir(tempRepo);
    await execFileAsync("git", ["init"]);

    await mkdir(".pi/metricEnforcer", { recursive: true });
    await writeFile(
      ".pi/metricEnforcer/metric-enforcer.config.json",
      JSON.stringify(
        {
          logLevel: "warn", // invalid on purpose: the loader emits a warning and falls back to "warning"
          analyzers: { ccsh: { enabled: false, command: "node", args: ["-e", ""] } },
          backpressure: { errorOnly: false, maxBackpressureRetries: 3 },
          thresholds: { global: {}, filePatterns: {} },
          metricDefinitions: {},
        },
        null,
        2,
      ),
      "utf8",
    );

    const notifications: Notification[] = [];
    const ctx: TestContext = {
      hasUI: true,
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

    const countLogLevelWarnings = () =>
      notifications.filter((entry) => entry.message.includes('Invalid "logLevel"')).length;

    const fakePi = new FakePi();
    metricEnforcer(fakePi as never);

    // Two agent starts within the same user turn (as happens across backpressure retries) must not
    // re-log the same config warning.
    await fakePi.emit("agent_start", ctx);
    await fakePi.emit("agent_start", ctx);
    assert.equal(countLogLevelWarnings(), 1);

    // A new user turn clears the suppression, so the warning surfaces again.
    await fakePi.emit("input", ctx, { source: "user" });
    await fakePi.emit("agent_start", ctx);
    assert.equal(countLogLevelWarnings(), 2);
  } finally {
    process.chdir(previousCwd);
  }
});
