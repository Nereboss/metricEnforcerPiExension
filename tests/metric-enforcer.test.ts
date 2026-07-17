import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import metricEnforcer from "../extensions/metric-enforcer.ts";

const execFileAsync = promisify(execFile);

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
