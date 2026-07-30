---
date: 2026-07-30T12:48:30.713485+00:00
git_commit: 13ca8665ce539f6c07fc3c4cf89732e221e13e09
branch: main
topic: "Temporary hash-based quality-gate waivers for pre-existing file violations"
tags: [plan, metric-enforcer, quality-gate, backpressure, pi-extension]
status: ready
---

# PLAN: Temporary File Quality-Gate Waivers

## Goal

Allow an LLM to explicitly waive MetricEnforcer checks for one already-touched file when its violation is clearly pre-existing and unrelated to the current change. The waiver is temporary: it applies only in the active quality-gate/backpressure cycle and is automatically revoked as soon as that file changes again.

This addresses the case where a small valid change touches a legacy file with, for example, complexity `500` against an error threshold of `100`. The model can avoid an unrelated large refactor while the quality gate continues to protect all other files and resumes checking the waived file when it is edited again.

Estimated effort: approximately 0.5–1 implementation day, including tests and documentation.

## Acceptance Criteria

- [x] The LLM can call a discoverable Pi custom tool to temporarily waive one file from MetricEnforcer evaluation.
- [x] A waiver is accepted only for a normalized, project-relative file already tracked as touched in the active quality-gate cycle.
- [x] The tool rejects absolute paths, traversal outside the project, missing/deleted files, and files not tracked in the active cycle.
- [x] The waiver records the file's working-tree content hash at waiver time.
- [x] While the file hash remains unchanged, the file is excluded from analyzer orchestration, violation evaluation, and backpressure messages.
- [x] If the file changes after being waived, its waiver is automatically revoked before the next gate evaluation and it is checked normally.
- [x] Waiving one file does not suppress violations or backpressure for other eligible touched files.
- [x] If all tracked files are waived, MetricEnforcer skips analysis without reporting a false successful quality check or triggering an unnecessary retry.
- [x] Waivers are cleared at existing cycle boundaries: a new real user message, compliance, exhausted backpressure retries, deactivation, and extension/session reinitialization.
- [x] The policy injected into the model prompt permits the tool only for genuine pre-existing/out-of-scope violations and explicitly prohibits using it to evade violations introduced or materially affected by the model.
- [x] The README documents the tool, its temporary hash-based semantics, and its scope restrictions.
- [x] `npm run test` passes.

## Technical Key Decisions and Tradeoffs

1. **Use a Pi custom tool named `waive_metric_file`, not a slash command, as the primary interface.**
   - Why: Pi custom tools are directly callable by the LLM and appear in its available-tool context. Slash commands are primarily user interactions and do not provide a reliable model-action interface.
   - Impact: Register the tool through `pi.registerTool()` and define a strict typed input schema. A human-facing slash command is explicitly out of scope for this iteration.

2. **Store an in-memory `filePath -> contentHash` waiver map.**
   - Why: The requested lifetime is "until the file is edited again." Comparing the snapshot hash at evaluation time precisely implements that condition and naturally handles file replacement as a changed file.
   - Impact: Waivers are ephemeral and do not need configuration, project files, session persistence, or migration logic.

3. **Restrict waivers to files already in `cumulativeAgentTouchedFiles`.**
   - Why: This prevents pre-emptively disabling the gate for arbitrary files and retains the existing changed-file ownership model.
   - Impact: The tool validates state captured by MetricEnforcer rather than allowing generic path ignores.

4. **Exclude files immediately before orchestration rather than modifying analyzers or threshold evaluation.**
   - Why: The waiver is a quality-gate-cycle concern, not an analyzer capability or a permanent threshold rule. The existing analyzer plugins and evaluator remain reusable and unchanged.
   - Impact: Filter the existing tracked-file list passed into `runMetricOrchestrationWithRetries()`.

5. **Do not add permanent ignores or configuration fields.**
   - Why: Permanent path ignores could silently weaken the quality gate and are not needed for this targeted exception workflow.
   - Impact: No config-schema, config-loader, or rule-evaluator changes are expected.

## Current State

MetricEnforcer tracks uncommitted Git working-tree hashes before and after each low-level agent run. At `agent_end`, it adds files changed by the agent to a cumulative set, analyzes all currently existing files in that set, evaluates configured thresholds, and sends a steer/backpressure message for remaining violations.

```text
real user input
  |
  +--> input handler marks the next agent start as a new cycle
  |
  +--> agent_start
  |      +--> reset cumulative state if a new cycle
  |      +--> capture Git snapshot
  |
  +--> agent_end
         +--> capture ending Git snapshot
         +--> diff snapshots -> changedByAgentThisTurn
         +--> add files to cumulativeAgentTouchedFiles
         +--> filter deleted files
         +--> run analyzer orchestration
         +--> evaluate threshold violations
         +--> send MetricEnforcer steer message or close/reset cycle
```

Relevant implementation points:

- `extensions/metric-enforcer.ts`
  - module state: `cumulativeAgentTouchedFiles` (line 38)
  - cycle reset helpers: `resetTrackingStateForNewCycle()` and `clearTrackingAndMarkNextAgentStartAsNewCycle()` (lines 230–245)
  - eligible tracked-file lookup: `getCurrentlyTrackedExistingFiles()` (lines 251–253)
  - existing activate/deactivate command registration (lines 392–422)
  - end-of-run orchestration and backpressure path (lines 470–523)
- `extensions/metric-enforcer/orchestrator.ts`
  - accepts a list of touched files and confines analysis results and violations to that list.
- `extensions/metric-enforcer/backpressure.ts`
  - formats violations but has no file-selection responsibility.
- `metric-enforcer-quality-gate-policy.md`
  - currently directs the model to refactor every error-level violation, with no explicit waiver exception.
- `tests/metric-enforcer.test.ts`
  - contains the fake Pi harness and integration tests for cumulative files across retries and reset-on-user-message semantics.

The current cumulative behavior is intentional: `tests/metric-enforcer.test.ts` verifies that a violating file touched in an earlier backpressure retry remains checked even if it was not touched in a later retry. The waiver must be a narrow override to this behavior.

## Desired End State

```text
Agent changes legacy.ts
  |
  +--> existing gate detects pre-existing complexity=500 > max=100
  |
  +--> model calls waive_metric_file({ filePath: "legacy.ts", reason: "..." })
  |      +--> verify legacy.ts is cumulatively tracked and exists
  |      +--> record its current hash as waiver baseline
  |
  +--> next agent_end
         +--> compare waived hashes to end snapshot
         +--> revoke a waiver if the associated file changed
         +--> analyze only non-waived tracked files
         +--> backpressure only for violations in those eligible files

Later, agent edits legacy.ts again
  |
  +--> hash differs from waiver baseline
  +--> waiver is revoked
  +--> legacy.ts resumes normal analysis and backpressure
```

Example model tool call and result:

```text
waive_metric_file({
  filePath: "src/legacy.ts",
  reason: "The existing complexity is unrelated to my two-line bug fix."
})

=> MetricEnforcer will exclude src/legacy.ts from this quality-gate cycle.
   It will be checked again automatically if its contents change.
```

## Abstractions and Code Reuse

- Reuse existing Git snapshots (`Map<string, string>`) and `MISSING_FILE_HASH` rather than creating a second file-hashing mechanism.
- Reuse `cumulativeAgentTouchedFiles` as the authority for whether the model may waive a file.
- Reuse `filterExistingFiles()` and deterministic path sorting for candidate-file handling.
- Reuse the existing cycle-reset helpers, extending them to reset waiver state together with retry/tracking state.
- Reuse the existing orchestrator API by passing it only the filtered eligible file list. Do not add waiver logic to analyzer plugin interfaces, analyzer implementations, or the rule evaluator.
- Keep input/path/hash validation in a focused helper module if it keeps the entry point readable; otherwise retain small lifecycle-specific helpers in the extension entry point.

Expected changes:

```text
extensions/
  metric-enforcer.ts                         # waiver state, custom tool, lifecycle filtering
  metric-enforcer/
    waiver.ts                                # optional: path/hash/waiver helper types and functions
metric-enforcer-quality-gate-policy.md       # policy exception and model-use constraints
README.md                                    # feature documentation
package.json                                 # add typebox runtime dependency only if Pi's transitive availability is not supported

tests/
  metric-enforcer.test.ts                    # FakePi custom-tool support and integration coverage
  waiver.test.ts                             # optional: pure helper/path validation unit tests
```

## Logging & Observability

Use the existing `logInfo`/`logWarning` mechanism and configured log level. Avoid exposing a full waiver reason in normal notifications if it could be sensitive; the Pi tool call itself remains auditable in the session history.

Expected info-level notifications:

```text
MetricEnforcer temporarily waived src/legacy.ts for the current quality-gate cycle.
MetricEnforcer resumed checking src/legacy.ts because the file changed after its waiver.
MetricEnforcer skipped 1 waived file for this quality-gate cycle.
```

The tool result should clearly communicate successful activation and automatic revocation-on-change. Validation failures should be actionable, for example:

```text
Cannot waive src/other.ts: it was not changed by the agent in the active quality-gate cycle.
Cannot waive ../outside.ts: file paths must be project-relative and remain inside the project.
```

## Implementation

### Phase 1: Add temporary waiver state and model-callable interface

Dependencies: None.

Introduce the hash-bound waiver model and expose the narrowly scoped custom tool. This phase makes the feature callable but does not yet modify analyzer selection.

**Tasks**:
- [x] Inspect the installed Pi extension API/types and confirm the supported `registerTool()` input schema import and tool-result shape for this repository's `@mariozechner/pi-coding-agent` peer dependency.
- [x] Add a focused waiver representation, preferably `Map<string, string>` mapping normalized project-relative file paths to the working-tree hash at waiver time.
- [x] Add helpers to clear waiver state, normalize/validate a project-relative path, and determine whether a tracked file can be waived without allowing absolute paths or repository traversal.
- [x] Reuse `getWorkingTreeSnapshot()` to obtain the waiver baseline hash; reject files absent from that snapshot, including deleted files.
- [x] Extend `resetTrackingStateForNewCycle()` and `clearTrackingAndMarkNextAgentStartAsNewCycle()` so waiver state is always reset with the existing retry and cumulative-file lifecycle.
- [x] Register `waive_metric_file` using `pi.registerTool()` with required `filePath` and optional `reason` inputs.
- [x] Make the tool reject files not present in `cumulativeAgentTouchedFiles`, paths outside the project, and files without a current snapshot hash.
- [x] On successful invocation, record the normalized path/hash waiver and return an explicit confirmation that the waiver is limited to the current cycle and revoked when the file changes.
- [x] Update the `FakePi` test harness in `tests/metric-enforcer.test.ts` to capture registered custom-tool definitions and invoke a tool with typed test inputs.
- [x] Add integration tests for tool registration, accepting a valid tracked file, and rejecting untracked, missing, absolute, and traversal paths.

**Automated Verification**:
- [x] The new custom-tool tests pass through `node --test tests/metric-enforcer.test.ts`.
- [x] Existing lifecycle-handler registration expectations are updated only if registering a tool requires observable harness changes; event registration behavior remains unchanged.
- [x] `npm run test` passes.

### Phase 2: Filter waived files and automatically revoke changed-file waivers

Dependencies: Phase 1.

Apply temporary waivers at the precise point where MetricEnforcer selects files for orchestration. Preserve all non-waived behavior, including cumulative retry checking.

**Tasks**:
- [x] Add a helper that compares each waived file's saved baseline hash with `endSnapshot` and removes waivers for files whose hash differs or whose snapshot entry is absent.
- [x] Log an info-level notification when a waiver is revoked because the file changed, while respecting the configured log level and existing warning-deduplication approach where applicable.
- [x] Replace `getCurrentlyTrackedExistingFiles(endSnapshot)` with a helper that returns sorted, existing, cumulative tracked files excluding active waivers.
- [x] In the `agent_end` flow, add newly changed files, revoke stale waivers against the ending snapshot, then calculate eligible files before calling `runMetricOrchestrationWithRetries()`.
- [x] Define and implement the all-files-waived branch: do not invoke analyzers, do not claim that metric checks passed, do not emit a quality-gate steer message, and close/reset the current backpressure cycle consistently.
- [x] Emit an info-level notification for skipped waived files when applicable.
- [x] Ensure deactivation, successful compliance, exhausted retries, and a subsequent real user message all clear waiver state through the extended existing reset helpers.
- [x] Add an integration test proving that a waived violating file no longer produces backpressure.
- [x] Add an integration test proving that a non-waived violating file still produces backpressure when another tracked file is waived.
- [x] Add an integration test proving that a waived file is checked and can produce backpressure again after its content changes.
- [x] Add integration tests for waiver resets at the existing new-user-cycle and deactivate/reactivate boundaries.
- [x] Add an integration test for the all-files-waived branch, asserting analyzer invocation is skipped and no false "Metric checks passed" notification or steer message is produced.

**Automated Verification**:
- [x] Existing cross-turn backpressure behavior for non-waived files remains covered and passes.
- [x] New waiver integration tests pass deterministically without external analyzer dependencies, using the existing Node-based fake analyzer pattern.
- [x] `npm run test` passes.

### Phase 3: Define model policy and public documentation

Dependencies: Phases 1–2.

Make the capability discoverable to the LLM and explain its guardrails to extension users.

**Tasks**:
- [x] Update `metric-enforcer-quality-gate-policy.md` to instruct the model that it may use `waive_metric_file` only when an error-level violation clearly predates its change and remediation is outside the user's task.
- [x] State in the policy that the tool must not be used to evade violations introduced or materially affected by the model's changes.
- [x] State in the policy that the waiver is per-file, lasts only for the active quality-gate cycle, and is automatically removed when the file changes again.
- [x] Update `README.md` main features and usage documentation with the temporary-waiver behavior, tool name/input example, validation restrictions, and non-permanent nature.
- [x] Add/adjust the policy-injection integration test to assert the injected system prompt contains the waiver guidance.
- [x] Add/adjust tool-result tests to ensure user-facing confirmation clearly states the auto-revocation behavior.

**Automated Verification**:
- [x] Policy injection tests verify the tool exception and scope restrictions are included in the system prompt.
- [x] README examples match the registered tool name and parameter names.
- [x] `npm run test` passes.

**Manual Verification**:
- [ ] Run Pi with the package enabled, make a small change to a deliberately over-threshold legacy file, and verify the model can call `waive_metric_file` after receiving the metric backpressure.
- [ ] Make a second change to that same file in the active backpressure cycle and verify the quality gate resumes reporting its violation.

## Implementation Notes

- Do not use the waiver mechanism to mutate `cumulativeAgentTouchedFiles`; keep tracking and waiver eligibility separate. This preserves the ability to resume checking automatically when the file changes.
- Do not treat an all-waived file list as ordinary compliance. The gate did not evaluate any eligible file, so a successful-check message would be misleading.
- The implementation should normalize path input consistently with Git status paths. Confirm platform-specific path separator behavior before finalizing helper APIs.
- If a pure `waiver.ts` module is added, keep it limited to domain logic that can be unit tested independently; event registration and Pi API calls should remain in `extensions/metric-enforcer.ts`.
- A slash command for manual users and persistent/configured exclusions are intentionally deferred. They should be separate features because they change the user interface and the quality-gate trust model.

## References

- `extensions/metric-enforcer.ts`
- `extensions/metric-enforcer/orchestrator.ts`
- `extensions/metric-enforcer/backpressure.ts`
- `extensions/metric-enforcer/quality-gate.ts`
- `metric-enforcer-quality-gate-policy.md`
- `README.md`
- `tests/metric-enforcer.test.ts`
- `tests/backpressure.test.ts`
- Pi extension documentation: `/Users/niklaskneissl/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
