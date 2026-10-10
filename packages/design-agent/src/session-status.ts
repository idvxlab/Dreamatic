import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function stopAfterCommittedTurn(agent: AgentSession["agent"], committed: () => boolean): () => void {
  const previous = agent.shouldStopAfterTurn;
  const stop: NonNullable<typeof previous> = async (context, signal) => (context.message?.role === "assistant" && context.message.stopReason === "length") || committed() || Boolean(await previous?.(context, signal));
  agent.shouldStopAfterTurn = stop;
  return () => {
    if (agent.shouldStopAfterTurn !== stop) return;
    if (previous) agent.shouldStopAfterTurn = previous;
    else delete agent.shouldStopAfterTurn;
  };
}

export function dreamaticSessionFailure(messages: readonly unknown[]): string | undefined {
  const tail = messages.at(-1);
  const latest = tail && typeof tail === "object" && "role" in tail && tail.role === "toolResult"
    ? messages.findLast(item => !!item && typeof item === "object" && "role" in item && item.role === "assistant") : tail;
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return undefined;
  const message = latest as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (message.role !== "assistant" || !["error", "length"].includes(String(message.stopReason))) return undefined;
  if (message.stopReason === "length") return "model output token limit reached: response truncated; partial arguments are not committed";
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage
    : "The model stopped with an unspecified error";
}
