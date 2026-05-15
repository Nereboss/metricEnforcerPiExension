export const QUALITY_GATE_CUSTOM_TYPE = "quality-gate";
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
