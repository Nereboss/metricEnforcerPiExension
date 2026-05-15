MetricEnforcer quality-gate policy (apply rules for the conversation after messages of type "quality-gate" until the next user message):
- Messages with customType "quality-gate" come from an extension judging code quality.
- Violations with severity "error" should be fixed immediately through refactoring the effected file.
- Violations with severity "warning" mean that the metic is getting close to the allowed threshold and files should be refactored soon
- These refactorings are not part of the explicit conversation with the user, except when stated to be so in a user message
- Do necessary refactorings to address the listed violations without further user interaction, then continue the current user objective