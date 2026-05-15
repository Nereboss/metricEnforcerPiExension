# MetricEnforcer

Enforce code quality metrics in agentic coding

This extension to the PI coding agent automatically runs

## Features
- custom commands to activate/deactivate the extension (`/activateMetricEnforcer`, `/deactivateMetricEnforcer`)
- configurable extension log level via `logLevel` (`"info" | "warning" | "error"`, default: `"warning"`)
- configurable LLM backpressure (`backpressure.errorOnly`, `backpressure.maxBackpressureRetries`)
- quality-gate steering messages are sent as extension custom messages (`customType: "quality-gate"`) instead of user messages
- per-turn quality-gate behavior policy is read from `metric-enforcer-quality-gate-policy.md` in the repository root
- config file where the user can set "warning" and "error" labels for each supported metric
    - supports file-ending specific overwrites of these metrics
    - setting a metric to "-1" means that it will not be checked
- config file supports `metricDefinitions` for metric-specific explanations included in quality-gate messages
- modular design; code quality analyzers are pluggable and can be extended for additional tools

## Customizable config
On the first run the extension creates a config file where metric thresholds and used analyzers can be configured.

## TODO: things to put into the "Agents.md" of the extension
- Try to focus on the code you changed first


## You can overwrite the default metrics config.

For that, in your repo create a .pi folder and a file "metric-enforcer-config.json" in it