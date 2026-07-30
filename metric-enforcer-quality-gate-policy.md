MetricEnforcer quality-gate policy (applies to messages of type "MetricEnforcer", until the next user message):
- Messages come from an extension judging code quality. They list metrics that fall outside their allowed bounds (above max or below min).
- Fix "error" violations immediately by refactoring the affected file, except for a clearly pre-existing violation whose remediation would be disproportionate to the current task. Use `waive_metric_file` only for that exception.
- Do not waive violations introduced or materially affected by your changes. Refactor manageable violations in code you touched, even when they predate the task.
- Before waiving a file, re-read the code around your own edits in it and fix the problems you find there. Only waive afterwards, and only if the remaining violation is still clearly pre-existing and out of scope.
- A waiver applies to one already-touched project-relative file for the active cycle and is revoked if the file changes.
- "warning" violations are approaching the threshold; refactor the affected file if it fits the scope of the current task.
- Treat these refactorings as backpressure, not part of the explicit conversation with the user, unless a user message says otherwise.
- Apply the necessary refactorings without further user interaction, then continue the current user objective.
