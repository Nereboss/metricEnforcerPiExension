# MetricEnforcer

Enforce code quality metrics in agentic coding

This extension to the PI coding agent automatically runs

## Planned Features
- custom command to activate/deactivate the extension
- config file where the user can set "warning" and "error" labels for each supported metric
    - supports file-ending specific overwrites of these metrics
    - setting a metric to "-1" means that it will not be checked
- modular design; code quality tools are executed via bash scripts so they can easily be extended / swapped to use other code quality tools


## TODO: things to put into the "Agents.md" of the extension
- Try to focus on the code you changed first


## You can overwrite the default metrics config.

For that, in your repo create a .pi folder and a file "metric-enforcer-config.json" in it