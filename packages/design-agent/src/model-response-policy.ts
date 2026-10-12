/** Runtime-only watchdog policy; never treats partial tool arguments as durable output. */
import { THINKING_LEVELS, type ThinkingLevel } from "./provider.js";

/** Aggregate evidence only: no reasoning text or partial tool arguments in diagnostics. */
export function modelResponseEvidence(message: unknown) {
  const m = message && typeof message === "object" ? message as Record<string, unknown> : {};
  const content = Array.isArray(m.content) ? m.content : [];
  const chars = (type: string, field: string) => content.reduce((sum, item) => sum + (item?.type === type && typeof item[field] === "string" ? item[field].trim().length : 0), 0);
  const reasoningChars = chars("thinking", "thinking"), textChars = chars("text", "text");
  const toolCalls = content.filter(item => item?.type === "toolCall").length;
  const usage = m.usage && typeof m.usage === "object" ? m.usage as Record<string, unknown> : {};
  const tokens = (field: string) => typeof usage[field] === "number" && Number.isFinite(usage[field]) && Number(usage[field]) >= 0 ? Number(usage[field]) : null;
  const reasoningTokens = tokens("reasoning"), outputTokens = tokens("output");
  const reasoningObserved = reasoningChars > 0 || (reasoningTokens ?? 0) > 0;
  const truncationKind = m.stopReason === "length" ? reasoningObserved && !textChars && !toolCalls ? "reasoning_exhausted" : "output_truncated" : null;
  return { reasoningChars, textChars, toolCalls, reasoningTokens, outputTokens, reasoningObserved, truncationKind };
}

/** A single recovery may change a verified control; never switch models or invent fields. */
export function reasoningRecoveryPlan(model: { reasoning: boolean; api: string; thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>; compat?: unknown }, current: ThinkingLevel, available: readonly ThinkingLevel[], recoveries: number) {
  if (recoveries >= 1) return { retry: false as const, reason: "reasoning_recovery_limit" };
  const compat = model.compat as { thinkingFormat?: string; supportsReasoningEffort?: boolean; thinkingTokenBudgetField?: string; supportsThinkingTokenBudget?: boolean; chatTemplateKwargs?: Record<string, unknown>; chatTemplateArgs?: Record<string, unknown> } | undefined;
  const native = ["openai-responses", "azure-openai-responses", "openai-codex-responses", "anthropic-messages", "bedrock-converse-stream", "google-generative-ai", "google-vertex", "mistral-conversations", "pi-messages"].includes(model.api);
  if (!model.reasoning || (!native && (model.api !== "openai-completions" || !compat?.thinkingFormat))) return { retry: false as const, reason: "no_verified_thinking_control" };
  const dynamicTemplate = Object.values(compat?.chatTemplateKwargs ?? compat?.chatTemplateArgs ?? {}).some(value => value && typeof value === "object" && (value as Record<string, unknown>).$var === "thinking.enabled" && !(value as Record<string, unknown>).omitWhenOff);
  const format = compat?.thinkingFormat ?? "";
  const mappedOff = typeof model.thinkingLevelMap?.off === "string" && model.thinkingLevelMap.off !== (model.thinkingLevelMap?.[current] ?? current);
  const canDisable = native || ["qwen", "qwen-chat-template", "zai", "deepseek", "together"].includes(format)
    || (["openrouter", "string-thinking"].includes(format) && (model.thinkingLevelMap?.off ?? "none") !== (model.thinkingLevelMap?.[current] ?? current))
    || (["openai", "baseten"].includes(format) && compat?.supportsReasoningEffort === true && mappedOff)
    || dynamicTemplate;
  if (current !== "off" && available.includes("off") && model.thinkingLevelMap?.off !== null && canDisable) return { retry: true as const, nextLevel: "off" as ThinkingLevel, reason: "disable_thinking_for_recovery" };
  const canReduce = native || (compat?.supportsReasoningEffort === true && ["openai", "qwen", "zai", "deepseek", "together", "baseten"].includes(format)) || !!compat?.thinkingTokenBudgetField || compat?.supportsThinkingTokenBudget === true
    || ["ant-ling", "string-thinking", "openrouter"].includes(format)
    || Object.values(compat?.chatTemplateKwargs ?? compat?.chatTemplateArgs ?? {}).some(value => value && typeof value === "object" && ["thinking.effort", "thinking.budget"].includes(String((value as Record<string, unknown>).$var)));
  const index = THINKING_LEVELS.indexOf(current);
  const nextLevel = THINKING_LEVELS.find((level, i) => i > 0 && i < index && available.includes(level) && model.thinkingLevelMap?.[level] !== null && (format !== "ant-ling" || typeof model.thinkingLevelMap?.[level] === "string")
    && (model.thinkingLevelMap?.[level] ?? level) !== (model.thinkingLevelMap?.[current] ?? current));
  return canReduce && nextLevel ? { retry: true as const, nextLevel, reason: "reduce_thinking_for_recovery" } : { retry: false as const, reason: "no_lower_verified_thinking_control" };
}

export function responseTimeoutReason(elapsedMs: number, idleMs: number, generationMs: number | undefined, limits: { firstOutputMs: number; idleMs: number; generationMs: number; totalMs: number }) {
  if (elapsedMs >= limits.totalMs) return 'model total deadline';
  if (generationMs === undefined) return elapsedMs >= limits.firstOutputMs ? 'first output deadline' : undefined;
  if (idleMs >= limits.idleMs) return 'stream stalled';
  return generationMs >= limits.generationMs ? 'generation deadline' : undefined;
}

export function modelRecoveryTask(reason: string | undefined, role?: string) {
  if (reason?.includes("reasoning exhausted")) return "The previous response exhausted its allowance on reasoning before any text or tool call. Runtime has selected a lower verified thinking control for this recovery. Resume from durable tool results and produce the next concise complete role-owned update or source file. Do not repeat successful research or Skill loading, reconstruct the whole design, or split Context roots into overwrites. Never execute or reuse truncated tool arguments; never create a new Run or change models.";
  const exceededAllowance = reason?.includes('token limit') || reason?.includes('generation deadline') || reason?.includes('model total deadline');
  const policy = exceededAllowance
    ? 'The complete response exceeded its generation allowance. Produce a concise complete role Context using actual evidence and source references; omit repeated quotations and repeated asset metadata. Never split required Context roots into separate overwrites or reuse truncated tool arguments.'
    : reason?.includes('first output deadline')
      ? 'The provider did not produce its first output in time. Resume once from durable results; do not enlarge the task or repeat acquisition.'
      : 'The provider connection failed or its stream stalled. Resume from durable results without repeating successful acquisition.';
  const sourceRecovery = role === 'designer' && exceededAllowance
    ? ' If a source write was interrupted, change its structure before retrying: inspect completed files, then save complete local HTML, CSS, JavaScript and content modules in separate writes, one file per response with path before content. Keep a small HTML entry linking those modules and map every file in the same deliverable execution.files. Preserve requested content and behavior; do not retry the whole page in one call, append partial markup, or treat streamed text as saved. Continue from successful writes, then update and commit Context when all required sources exist.'
    : '';
  return `${policy}${sourceRecovery} Read design_context_read once with only needed canonical paths. Preserve completed files and loaded Skills. Use role-owned Context tools for Context content; file tools are only for permitted source files. Never create a new Run or have Orchestrator author another role’s outputs.`;
}

/** Only aggregate request structure and explicitly known control fields are logged. */
export function providerRequestSummary(payload: unknown, templateCapabilities?: unknown) {
  const templates = templateCapabilities as { chatTemplateKwargs?: Record<string, unknown>; chatTemplateArgs?: Record<string, unknown> } | undefined;
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const messages = Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : [];
  const controls: Record<string, unknown> = {};
  const templateSwitches: unknown[] = [];
  const templateEfforts: unknown[] = [];
  for (const key of ['enable_thinking', 'thinking', 'reasoning_effort', 'thinking_budget', 'thinking_token_budget', 'thinking_budget_tokens', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (typeof p[key] === 'boolean' || typeof p[key] === 'number' || typeof p[key] === 'string') controls[key] = p[key];
  }
  for (const [key, field] of [["thinking", "type"], ["thinking", "budget_tokens"], ["reasoning", "effort"], ["reasoning", "enabled"], ["reasoning", "max_tokens"]]) {
    const nested = p[key!];
    const value = nested && typeof nested === "object" ? (nested as Record<string, unknown>)[field!] : undefined;
    if (["string", "number", "boolean"].includes(typeof value)) controls[`${key}.${field}`] = value;
  }
  for (const [field, definition] of [["chat_template_kwargs", templates?.chatTemplateKwargs], ["chat_template_args", templates?.chatTemplateArgs]] as const) {
    const template = p[field];
    if (!template || typeof template !== "object") continue;
    for (const key of new Set(["enable_thinking", "reasoning_effort", "thinking_budget", ...Object.entries(definition ?? {}).filter(([, value]) => value && typeof value === "object" && "$var" in value).map(([key]) => key)])) {
      const value = (template as Record<string, unknown>)[key];
      if (["string", "number", "boolean"].includes(typeof value)) {
        controls[`${field}.${key}`] = value;
        const variable = definition?.[key] as { $var?: string } | undefined;
        if (variable?.$var === "thinking.enabled") templateSwitches.push(value);
        if (variable?.$var === "thinking.effort") templateEfforts.push(value);
      }
    }
    if (field === "chat_template_kwargs" && typeof (template as Record<string, unknown>).enable_thinking === "boolean") controls.templateThinking = (template as Record<string, unknown>).enable_thinking;
  }
  const toolConstraints = { strict: 0, nonStrict: 0, unspecified: 0 };
  for (const tool of Array.isArray(p.tools) ? p.tools : []) {
    const declaration = tool?.function ?? tool;
    if (declaration?.strict === true) toolConstraints.strict++;
    else if (declaration?.strict === false) toolConstraints.nonStrict++;
    else toolConstraints.unspecified++;
  }
  const controlValues = Object.entries(controls).filter(([key]) => /thinking|reasoning|^chat_template_/u.test(key));
  const offValues = ["off", "none", "disabled"];
  const offRequested = templateSwitches.includes(false) || templateEfforts.some(value => offValues.includes(String(value))) || controlValues.some(([key, value]) => /enable_thinking|enabled|templateThinking/.test(key) ? value === false : /effort|type|^thinking$/.test(key) && offValues.includes(String(value)));
  const onRequested = templateSwitches.includes(true) || controlValues.some(([key, value]) => /enable_thinking|enabled|templateThinking/.test(key) ? value === true : /type/.test(key) && ["enabled", "adaptive"].includes(String(value)));
  const thinkingControl = controlValues.length ? "explicit" : "unspecified";
  const controlState = offRequested && onRequested ? "conflicting" : offRequested ? "off_requested" : onRequested ? "on_requested" : controlValues.length ? "parameters_sent" : "unspecified";
  return { thinkingControl, controlState, toolConstraints, model: typeof p.model === 'string' ? p.model : undefined, messageCount: messages.length, serializedInputChars: JSON.stringify(messages).length, toolCount: Array.isArray(p.tools) ? p.tools.length : 0, controls };
}
