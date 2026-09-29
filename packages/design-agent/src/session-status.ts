export function dreamaticSessionFailure(messages: readonly unknown[]): string | undefined {
  const latest = messages.at(-1);
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return undefined;
  const message = latest as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage
    : "The model stopped with an unspecified error";
}
