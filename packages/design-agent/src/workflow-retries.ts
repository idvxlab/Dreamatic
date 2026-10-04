interface RetryNode {
  id: string;
  kind: string;
  status: string;
  label: string;
  agent?: string;
  at?: string;
  endedAt?: string;
  children?: RetryNode[];
}

export function settleWorkflowRetries<Node extends RetryNode>(workflow: Node[], event: Record<string, unknown>): Node[] {
  const type = String(event.type ?? "");
  const operationEnd = type === "operation_finished" || type === "operation_interrupted";
  const agentEnd = type === "agent_finished" || type === "agent_interrupted";
  const owner = type === "build_done" ? "builder" : type === "research_done" ? "researcher" : agentEnd ? String(event.agent ?? "") : undefined;
  if (!operationEnd && !agentEnd && !owner && type !== "export_done") return workflow;
  const id = `retry-${String(event.operation ?? "operation")}-${String(event.scope ?? "default")}`;
  const status = type.endsWith("interrupted") || event.status === "interrupted" ? "interrupted" : event.status === "error" ? "error" : "completed";
  const at = typeof event.at === "string" ? event.at : undefined;
  const visit = <Entry extends RetryNode>(node: Entry, parentAgent?: string): Entry => {
    const agent = node.agent ?? parentAgent;
    const matches = operationEnd ? node.id === id : type === "export_done" || (owner && (
      agent === owner || (owner === "builder" && node.id.startsWith("retry-image_")) || (owner === "researcher" && /^retry-(research_|websearch)/.test(node.id))
    ));
    const predates = !at || !node.at || Date.parse(node.at) <= Date.parse(at);
    const resolved = node.kind === "retry" && matches && predates && (node.status === "running" || operationEnd)
      ? { ...node, status, endedAt: at, label: `${status === "completed" ? "Retry resolved" : "Retry stopped"} · ${node.label.replace(/^(Retrying |Retry resolved · |Retry stopped · )/, "")}` }
      : node;
    return { ...resolved, ...(node.children ? { children: node.children.map((child) => visit(child, agent)) } : {}) };
  };
  return workflow.map((node) => visit(node));
}
