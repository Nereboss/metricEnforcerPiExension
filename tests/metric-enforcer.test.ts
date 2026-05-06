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

  on(eventName: string, handler: (event: unknown, ctx: TestContext) => Promise<void>): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push(handler);
    this.handlers.set(eventName, existing);
  }

  async emit(eventName: string, ctx: TestContext): Promise<void> {
    const eventHandlers = this.handlers.get(eventName) ?? [];
    for (const handler of eventHandlers) {
      await handler({}, ctx);
    }
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
