# MetricEnforcer Refactor Plan (TypeScript-first, Extensible)

## Goal
Replace bash-heavy logic with a TypeScript architecture where:
1. analyzers are pluggable,
2. each analyzer handles both tool execution **and** output parsing,
3. all analyzers return the same normalized metric format,
4. one config controls enabled analyzers + warning/error thresholds (global + file-type specific).

### 1) Core workflow in extension
- Keep current `agent_start` / `agent_end` flow for touched-file detection.
- On `agent_end`:
  1. detect touched files
  2. run configured analyzer tool(s) + normalize tool output into a common internal format
  4. apply threshold rules
  5. notify user with violations summary

---

## Core Design

### 1) Analyzer plugins own execution + normalization
Each analyzer plugin should:
- run its underlying tool (e.g. `ccsh`),
- parse tool-specific output,
- return a shared normalized result format.

So the core system never needs to know raw ccsh (or other tool) output formats.

### 2) Shared analyzer output contract (single internal format)
All plugins return the same structure, e.g.:
- `AnalyzerResult`
  - `analyzer: string`
  - `files: Array<{ filePath: string; metrics: Record<string, number> }>`

This is the only format the rest of the extension consumes.

### 3) Rules evaluator
Purpose:
- take normalized analyzer results + config thresholds,
- determine violations,
- classify them as `warning` / `error`.

This module is tool-agnostic and only works on normalized metrics.

### 4) Config-driven orchestration
Single config should define:
- which analyzers are enabled,
- analyzer-specific settings (command/args/etc.),
- metric thresholds with optional `warning` and/or `error`,
- global metric rules,
- file-type-specific overrides (e.g. `*.ts`, `*.java`, etc.).

---

## Config Format Decision
Recommended approach:
- **Start with JSON** (`metric-enforcer.config.json`) for strict schema validation and simplicity in TypeScript.
- Optionally add YAML support later once format stabilizes.
- Avoid plain txt for main config (too hard to validate and evolve).

---

## Workflow on `agent_end`
1. Detect touched files.
2. Load config and resolve enabled analyzers.
3. Run analyzers (only for relevant touched files).
4. Collect normalized `AnalyzerResult[]`.
5. Run rules evaluator against configured thresholds.
6. Notify user with concise violations summary.

---

## Actionable Implementation Plan

1. ✅ **Define shared types**
   - `AnalyzerResult`, `FileMetrics`, `Violation`, `MetricRule`, `ResolvedThresholds`.

2. ✅ **Create analyzer plugin interface**
   - `name`
   - `isEnabled(config)`
   - `selectFiles(files, config)`
   - `analyze(files, config, ctx): Promise<AnalyzerResult>`

3. ✅ **Implement config schema + loader (JSON)**
   - Validate analyzers config.
   - Validate metric rules (`warning`/`error` optional, at least one required).
   - Support global + file-type-specific thresholds.

4. ✅ **Implement rules evaluator module**
   - Input: normalized metrics + resolved rules per file.
   - Output: violations with severity.
   - Independent, pure, unit-testable.

5. ✅ **Implement first plugin: `ccsh`**
   - Execute ccsh.
   - Parse ccsh output.
   - Map to normalized `AnalyzerResult`.

6. ✅ **Wire orchestrator into extension flow**
   - Keep touched-file detection.
   - Replace bash script call with analyzer orchestrator.
   - Analyze repo-level output and report violations only for touched files.

7. ✅ **Notification/logging layer**
   - centralized `MetricEnforcerLogger` class for extension messaging.
   - config-driven filtering via `logLevel` (`info` | `warning` | `error`, default `warning`).
   - quality backpressure is delivered as extension custom messages (`customType: "quality-gate"`) to avoid changing user intent.
   - per-turn quality-gate handling instructions are injected via `before_agent_start` from `metric-enforcer-quality-gate-policy.md` in extension repository root.
   - quality-gate context pruning keeps only quality-gate messages from the current user round.
   - quality-gate messages include a `Metric definitions` section sourced from `metricDefinitions` in config.

8. ✅ **Tests (minimal but critical)**
   - ccsh parser test with `sample_cc.json`
   - rules evaluator test for warning/error behavior
   - file-type override precedence test

---

## MVP Scope
- Config format: JSON only
- One analyzer plugin: `ccsh`
- Global thresholds + file-type overrides
- `warning` and `error` severities
- One concise UI summary

---

## Future Iteration Model
As discussed, each major block can later become its own dedicated implementation plan:
1. config system,
2. analyzer plugin system,
3. rules evaluator,
4. orchestration + UI/reporting.
