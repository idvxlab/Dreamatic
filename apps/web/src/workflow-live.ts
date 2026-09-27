import type { WorkflowEvent } from "./types";

const agentTitles: Record<string, string> = {
  "design-research": "Research agent",
  "design-planner": "Planning agent",
  "design-designer": "Design agent",
  "design-critic": "Critic agent",
};

const toolTitles: Record<string, string> = {
  web_search: "Searched the web",
  research_fetch: "Read research source",
  research_asset_discover: "Discovered reference images",
  research_asset_fetch: "Saved reference image",
  research_asset_validate: "Validated reference library",
  image_generate: "Generated design image",
  image_edit: "Edited design image",
  view_image: "Inspected image",
  compare_images: "Compared design images",
  artifact_lint: "Checked deliverables",
  design_bus_post: "Published workflow result",
  read: "Read project file",
  write: "Wrote project file",
  edit: "Edited project file",
  ls: "Inspected project files",
};

function text(value: unknown, limit = 1_200): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

function sorted(events: WorkflowEvent[]): WorkflowEvent[] {
  return events.sort((a, b) => Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
}

function updateAgent(workflow: WorkflowEvent[], invocationId: string, update: (agent: WorkflowEvent) => WorkflowEvent, seed?: Record<string, unknown>): WorkflowEvent[] {
  const index = workflow.findIndex((event) => event.kind === "agent" && event.id === invocationId);
  if (index >= 0) return workflow.map((event, eventIndex) => eventIndex === index ? update(event) : event);
  const agentName = typeof seed?.agent === "string" ? seed.agent : "design-specialist";
  const created: WorkflowEvent = {
    id: invocationId,
    kind: "agent",
    status: "running",
    actor: "Primary agent",
    agent: agentName,
    label: agentTitles[agentName] ?? agentName.replaceAll("-", " "),
    detail: text(seed?.task),
    at: typeof seed?.at === "string" ? seed.at : new Date().toISOString(),
    children: [],
    actionCount: 0,
  };
  return sorted([...workflow, update(created)]);
}

function artifactRefs(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const refs = value.filter((item): item is string => typeof item === "string").map((item) => item.replaceAll("\\", "/"));
  return refs.length ? refs : undefined;
}

export function applyWorkflowStreamEvent(workflow: WorkflowEvent[], event: Record<string, unknown>): WorkflowEvent[] {
  const type = typeof event.type === "string" ? event.type : "";
  const invocationId = typeof event.invocationId === "string" ? event.invocationId : undefined;
  const at = typeof event.at === "string" ? event.at : new Date().toISOString();
  if (type === "primary_tool_started") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : `primary-tool-${at}`;
    if (workflow.some((candidate) => candidate.id === id)) return workflow;
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    return sorted([...workflow, { id, kind: "tool", status: "running", actor: "Primary agent", label: toolTitles[toolName] ?? toolName.replaceAll("_", " "), tool: toolName, input: text(event.input, 900), at }]);
  }
  if (type === "primary_tool_finished") {
    const id = typeof event.toolCallId === "string" ? event.toolCallId : "";
    return workflow.map((candidate) => candidate.id === id ? { ...candidate, status: event.isError === true ? "error" : "completed", output: text(event.output), endedAt: at } : candidate);
  }
  if (invocationId && type === "agent_started") {
    return updateAgent(workflow, invocationId, (agent) => ({ ...agent, status: "running", detail: text(event.task) ?? agent.detail, at }), event);
  }
  if (invocationId && type === "tool_started") {
    const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : `${invocationId}-${at}`;
    return updateAgent(workflow, invocationId, (agent) => {
      if (agent.children?.some((child) => child.id === toolCallId)) return agent;
      const child: WorkflowEvent = { id: toolCallId, kind: "tool", status: "running", actor: agent.label, label: toolTitles[toolName] ?? toolName.replaceAll("_", " "), tool: toolName, input: text(event.input, 900), at };
      return { ...agent, children: sorted([...(agent.children ?? []), child]), actionCount: (agent.actionCount ?? 0) + 1 };
    }, event);
  }
  if (invocationId && type === "tool_finished") {
    const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
    return updateAgent(workflow, invocationId, (agent) => ({
      ...agent,
      children: (agent.children ?? []).map((child) => child.id === toolCallId ? { ...child, status: event.isError === true ? "error" : "completed", output: text(event.output), endedAt: at } : child),
    }), event);
  }
  if (invocationId && type === "reference_added" && typeof event.path === "string") {
    const path = event.path.replaceAll("\\", "/");
    return updateAgent(workflow, invocationId, (agent) => {
      const children = [...(agent.children ?? [])];
      const referenceIndex = children.findIndex((child) => child.kind === "references");
      const previous = referenceIndex >= 0 ? children[referenceIndex] : undefined;
      const assets = previous?.assets?.some((asset) => asset.path === path) ? previous.assets : [...(previous?.assets ?? []), { path, label: path.split("/").at(-1) ?? "Reference" }];
      const reference: WorkflowEvent = { id: `${invocationId}-references`, kind: "references", status: "completed", actor: agent.label, label: "Reference library", detail: `${assets.length} visual reference${assets.length === 1 ? "" : "s"} collected during this research step.`, at: previous?.at ?? at, endedAt: at, assets };
      if (referenceIndex >= 0) children[referenceIndex] = reference;
      else children.push(reference);
      return { ...agent, children: sorted(children) };
    }, event);
  }
  if (invocationId && type === "agent_retry") {
    return updateAgent(workflow, invocationId, (agent) => {
      const id = `${invocationId}-retry-${String(event.nextAttempt ?? at)}`;
      if (agent.children?.some((child) => child.id === id)) return agent;
      return { ...agent, children: sorted([...(agent.children ?? []), { id, kind: "retry", status: "running", actor: agent.label, label: `Reconnecting · attempt ${String(event.nextAttempt ?? "")}`.trim(), detail: text(event.error), at }]) };
    }, event);
  }
  if (invocationId && type === "agent_finished") {
    return updateAgent(workflow, invocationId, (agent) => ({ ...agent, status: "completed", output: text(event.output), endedAt: at }), event);
  }
  if (invocationId && type === "agent_interrupted") {
    return updateAgent(workflow, invocationId, (agent) => {
      const status = event.status === "interrupted" ? "interrupted" : "error";
      const id = `${invocationId}-error`;
      const error: WorkflowEvent = { id, kind: "error", status: "error", actor: agent.label, label: status === "interrupted" ? "Agent interrupted" : "Agent failed", detail: text(event.error), at };
      const children = [...(agent.children ?? []).filter((child) => child.id !== id), error];
      return { ...agent, status, endedAt: at, children: sorted(children) };
    }, event);
  }

  if (["operation_retry", "operation_interrupted"].includes(type) || event.summary || event.requestedAction) {
    const actor = typeof event.from_agent === "string" ? event.from_agent : typeof event.from === "string" ? event.from : "Workflow";
    const failed = type.includes("fail") || type.includes("interrupted") || event.severity === "error";
    const kind = type === "operation_retry" ? "retry" : failed ? "error" : "milestone";
    const node: WorkflowEvent = {
      id: typeof event.id === "string" ? event.id : `bus-${type}-${at}`,
      kind,
      status: failed ? "error" : "completed",
      actor,
      label: typeof event.summary === "string" ? event.summary : type.replaceAll("_", " "),
      detail: text(event.requestedAction) ?? text(event.error),
      at,
      stage: typeof event.phase === "string" ? event.phase : undefined,
      artifactRefs: artifactRefs(event.artifactRefs),
    };
    const ownerIndex = [...workflow].reverse().findIndex((candidate) => candidate.kind === "agent" && candidate.agent === actor && candidate.status === "running");
    if (ownerIndex >= 0) {
      const index = workflow.length - 1 - ownerIndex;
      return workflow.map((candidate, candidateIndex) => candidateIndex === index && !candidate.children?.some((child) => child.id === node.id)
        ? { ...candidate, children: sorted([...(candidate.children ?? []), node]) }
        : candidate);
    }
    return workflow.some((candidate) => candidate.id === node.id) ? workflow : sorted([...workflow, node]);
  }
  return workflow;
}
