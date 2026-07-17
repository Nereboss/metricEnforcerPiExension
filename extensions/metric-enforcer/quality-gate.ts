// Doubles as the title pi shows for these custom messages, so it is the user-facing name.
export const QUALITY_GATE_CUSTOM_TYPE = "MetricEnforcer";
export const QUALITY_GATE_POLICY_FILE_NAME = "metric-enforcer-quality-gate-policy.md";

interface ContextMessageShape {
  role?: string;
  customType?: string;
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface ContextEvent {
  messages: unknown[];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBeforeAgentStartEvent(value: unknown): value is BeforeAgentStartEvent {
  return isObjectRecord(value) && typeof value.systemPrompt === "string";
}

function isContextEvent(value: unknown): value is ContextEvent {
  return isObjectRecord(value) && Array.isArray(value.messages);
}

function isQualityGateMessage(message: unknown): boolean {
  if (!isObjectRecord(message)) return false;

  const typedMessage = message as ContextMessageShape;
  return typedMessage.role === "custom" && typedMessage.customType === QUALITY_GATE_CUSTOM_TYPE;
}

/**
 * Renders the configured metric definitions as a section for the system-prompt policy, so the model
 * has them once up front instead of on every backpressure message. Metrics without a definition are
 * skipped. Returns undefined when there is nothing to add, so callers can leave the policy untouched.
 */
export function formatMetricDefinitionsSection(
  metricDefinitions: Readonly<Record<string, string>>,
): string | undefined {
  const definedMetrics = Object.entries(metricDefinitions)
    .map(([metric, definition]) => [metric, definition.trim()] as const)
    .filter(([, definition]) => definition.length > 0)
    .sort(([left], [right]) => left.localeCompare(right));

  if (definedMetrics.length === 0) return undefined;

  return [
    "Metrics you may see in MetricEnforcer messages:",
    ...definedMetrics.map(([metric, definition]) => `- ${metric}: ${definition}`),
  ].join("\n");
}

export function getSystemPromptFromBeforeAgentStartEvent(event: unknown): string | undefined {
  if (!isBeforeAgentStartEvent(event)) return undefined;

  return event.systemPrompt;
}

export function getMessagesFromContextEvent(event: unknown): unknown[] | undefined {
  if (!isContextEvent(event)) return undefined;

  return event.messages;
}

export function pruneOldQualityGateMessages(
  messages: readonly unknown[],
  currentCycleQualityGateMessageCount: number,
): unknown[] {
  if (currentCycleQualityGateMessageCount <= 0) {
    return messages.filter((message) => !isQualityGateMessage(message));
  }

  let seenCurrentCycleQualityGateMessages = 0;

  return [...messages]
    .reverse()
    .filter((message) => {
      if (!isQualityGateMessage(message)) return true;

      if (seenCurrentCycleQualityGateMessages < currentCycleQualityGateMessageCount) {
        seenCurrentCycleQualityGateMessages += 1;
        return true;
      }

      return false;
    })
    .reverse();
}
