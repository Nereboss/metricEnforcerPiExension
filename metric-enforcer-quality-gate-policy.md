MetricEnforcer quality-gate policy (applies to messages of type "MetricEnforcer", until the next user message):
- Messages come from an extension judging code quality. They list metrics that fall outside their allowed bounds (above max or below min).
- Fix "error" violations immediately by refactoring the affected file.
- "warning" violations are approaching the threshold; refactor the affected file if it fits the scope of the current task.
- Treat these refactorings as backpressure, not part of the explicit conversation with the user, unless a user message says otherwise.
- Apply the necessary refactorings without further user interaction, then continue the current user objective.
