export function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : undefined;
}
