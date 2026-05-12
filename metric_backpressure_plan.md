# Metric Backpressure Plan (Phase 2)

## Goal
Turn metric violations from a passive report into active backpressure by feeding violations back to the LLM as a **user message**. The behavior should differentiate between **errors** and **warnings** and use a retry limit before giving up.

## Key Decisions
1. **Backpressure trigger**
   - Trigger when touched files contain warning and/or error violations.
   - No backpressure message when touched files are fully compliant.

2. **Single aggregated message vs. many messages**
   - Send one aggregated user message per evaluation cycle.
   - Group violations by file and metric.

3. **Severity-specific messaging**
   - **Errors:** Tell the agent to refactor now to reduce the metric below the error threshold.
   - **Warnings:** Tell the agent the metric is close to threshold and that if the affected file is touched further, it should consider refactoring to reduce the metric.

4. **Retry policy**
   - Introduce a config value for max backpressure retries (e.g. `maxBackpressureRetries`).
   - If violations remain after the configured number of retries, stop retrying and show a user warning that:
     - the metric is still violated,
     - the agent was unable to resolve it within allowed retries.

5. **Config-driven behavior**
   - Keep backpressure behavior configurable (retry count, handle warnings and errors or only errors).

## Implementation Steps
1. **Define backpressure + retry contract**
   - Add a small internal model for backpressure payloads and retry state per run/task.
   - Keep this separate from analyzer and rules evaluation logic.

2. **Create severity-aware message formatter**
   - Format one structured user message containing:
     - violated files/metrics,
     - actual vs threshold values,
     - severity-specific instruction text (error vs warning).

3. **Integrate into agent-end orchestration**
   - After evaluation:
     - no violations → normal success path,
     - violations + retries left → send backpressure user message,
     - violations + retries exhausted → stop backpressure and show user-facing warning.

4. **Add configuration fields (minimal)**
   - Add config options for:
     - `backpressure.errorOnly`, (boolean if only error or also warnings are handled)
     - `backpressure.maxBackpressureRetries`. (integer, -1 counts as infinite)
   - Define sensible defaults and validation rules.

5. **Implement retry tracking**
   - Track attempt count for the active run/task.
   - Increment on each backpressure cycle; reset when compliant or when a new run/task starts.

6. **Testing (focused)**
   - Unit tests for severity-specific message content (error and warning wording).
   - Unit tests for retry counting and exhausted-retry behavior.
   - Integration tests for:
     - warning/error violations trigger backpressure,
     - compliant result triggers none,
     - exhausted retries produce final user warning.

7. **Documentation update**
   - Update README/config docs with:
     - warning vs error backpressure semantics,
     - retry-limit behavior,
     - example configuration and expected messages.

## Minimal Deliverable
A working flow where warning and error violations on touched files are sent back as one user message with severity-specific guidance, and where backpressure stops after a configurable number of retries with a final user-visible warning if unresolved.