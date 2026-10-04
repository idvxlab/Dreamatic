import type { AgentSession } from "@earendil-works/pi-coding-agent";

export function stopAfterCommittedTurn(agent: AgentSession["agent"], committed: () => boolean): () => void {
  const previous = agent.shouldStopAfterTurn;
  const stop: NonNullable<typeof previous> = async (context, signal) => committed() || Boolean(await previous?.(context, signal));
  agent.shouldStopAfterTurn = stop;
  return () => {
    if (agent.shouldStopAfterTurn !== stop) return;
    if (previous) agent.shouldStopAfterTurn = previous;
    else delete agent.shouldStopAfterTurn;
  };
}

export function dreamaticSessionFailure(messages: readonly unknown[]): string | undefined {
  const latest = messages.at(-1);
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) return undefined;
  const message = latest as { role?: unknown; stopReason?: unknown; errorMessage?: unknown };
  if (message.role !== "assistant" || message.stopReason !== "error") return undefined;
  return typeof message.errorMessage === "string" && message.errorMessage.trim()
    ? message.errorMessage
    : "The model stopped with an unspecified error";
}
