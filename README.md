# MetricEnforcer

MetricEnforcer is an extension to the [PI coding agent](https://pi.dev/) that enforces code quality metrics during agentic coding runs.

## What the tool is

MetricEnforcer adds an automated quality gate to your PI workflow. It tracks files changed by the agent, runs configured metric analyzers, evaluates results against thresholds, and feeds violations back into the next turn as steering/backpressure messages.

## Installation

### Requisites
- PI coding agent
- Enabled code analyzers are installed and available in `PATH` (by default, `ccsh` from [CodeCharta](https://codecharta.com/))
- A Git repository (MetricEnforcer uses Git snapshots to detect changed files)


### Install as a PI package
1. Add the package to your project (example):
   - `pi install git:github.com/Nereboss/metricEnforcerPiExension`
2. Restart Pi or run `/reload`
3. Start PI and run one agent turn. On first run, MetricEnforcer creates a default config at:
   - `.pi/metricEnforcer/metric-enforcer.config.json`

## Main features

- **Automatic changed-file detection** during the time the agent runs
- **Config-driven analyzer orchestration**
- **Global + file-pattern-specific thresholds**
- **Warning/error severity model** per metric
- **Backpressure loop** to steer retries when violations occur
- **Analysis retries**: a quality gate re-runs its analyzers up to three times if any fail
- **Extendable analyzer architecture** for adding other code analyzer tools

### Activate/deactivate at any point
- `/activateMetricEnforcer` (on by default)
- `/deactivateMetricEnforcer`

## What settings can be customized

All settings are configured in:

- `.pi/metricEnforcer/metric-enforcer.config.json`

If the file does not exist, MetricEnforcer creates it at startup from the bundled default config.

### Configurable areas

- `logLevel`: `"info" | "warning" | "error"`
- `analyzers`: enable/disable analyzers and set `command`/`args`
- `backpressure.errorOnly`: apply backpressure only for error-level violations
- `backpressure.maxBackpressureRetries`: max retry count
- `thresholds.global`: default metric thresholds
- `thresholds.filePatterns`: per-pattern threshold overrides (for example `"*.ts"`)
- `metricDefinitions`: human-readable metric explanations added once to the system-prompt policy so the agent knows what each metric means

### Threshold semantics

- Threshold violations are evaluated as: `actual > threshold`
- `warning` and `error` can be configured independently per metric
- Setting a threshold to `-1` disables checking for that severity/metric

## Development

### Local development
1. Clone the repository.
2. Install dependencies (if needed by your environment).
3. Run tests:
   - `npm run test`

### Project structure
- `extensions/metric-enforcer.ts` – extension entry point and PI event wiring
- `extensions/metric-enforcer/orchestrator.ts` – analyzer execution + rule evaluation flow
- `extensions/metric-enforcer/analyzers/` – analyzer plugin implementations (for example `ccsh`)
- `extensions/metric-enforcer/rules/evaluator.ts` – threshold/violation evaluation
- `extensions/metric-enforcer/config/` – config loading and validation
- `tests/` – unit/integration coverage for parser, evaluator, config, orchestrator, and extension behavior