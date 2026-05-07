import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import metricEnforcer from "../extensions/metric-enforcer.ts";

const execFileAsync = promisify(execFile);

class FakePi {
  private handlers = new Map<string, Array<(event: unknown, ctx: TestContext) => Promise<void>>>();
  private commands = new Map<string, (args: string, ctx: TestContext) => Promise<void>>();

  on(eventName: string, handler: (event: unknown, ctx: TestContext) => Promise<void>): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }

  registerCommand(_name: string, options: { handler: (args: string, ctx: TestContext) => Promise<void> }): void {
    this.commands.set(_name, options.handler);
  }

  async emit(eventName: string, ctx: TestContext): Promise<void> {
    const eventHandlers = this.handlers.get(eventName) ?? [];
    for (const handler of eventHandlers) {
      await handler({}, ctx);
    }
  }

  async invokeCommand(name: string, args: string, ctx: TestContext): Promise<void> {
    const handler = this.commands.get(name);

    if (handler === undefined) {
      throw new Error(`Missing command handler for: ${name}`);
    }

    await handler(args, ctx);
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

  assert.deepEqual(fakePi.getRegisteredEventNames(), ["agent_end", "agent_start"]);
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
