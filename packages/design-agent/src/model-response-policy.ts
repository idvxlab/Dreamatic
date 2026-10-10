/** Runtime-only watchdog policy; never treats partial tool arguments as durable output. */
export function responseTimeoutReason(elapsedMs: number, idleMs: number, generationMs: number | undefined, limits: { firstOutputMs: number; idleMs: number; generationMs: number; totalMs: number }) {
  if (elapsedMs >= limits.totalMs) return 'model total deadline';
  if (generationMs === undefined) return elapsedMs >= limits.firstOutputMs ? 'first output deadline' : undefined;
  if (idleMs >= limits.idleMs) return 'stream stalled';
  return generationMs >= limits.generationMs ? 'generation deadline' : undefined;
}

export function modelRecoveryTask(reason: string | undefined) {
  const policy = reason?.includes('token limit') || reason?.includes('generation deadline') || reason?.includes('model total deadline')
    ? 'The complete response exceeded its generation allowance. Produce a concise complete role Context using actual evidence and source references; omit repeated quotations and repeated asset metadata. Never split required Context roots into separate overwrites or reuse truncated tool arguments.'
    : reason?.includes('first output deadline')
      ? 'The provider did not produce its first output in time. Resume once from durable results; do not enlarge the task or repeat acquisition.'
      : 'The provider connection failed or its stream stalled. Resume from durable results without repeating successful acquisition.';
  return `${policy} Read design_context_read once with only needed canonical paths. Preserve completed files and loaded Skills. Missing outputs must be created using the role-owned Context tool. Never create a new Run or have Orchestrator author another role’s outputs.`;
}

/** Only aggregate request structure and explicitly known control fields are logged. */
export function providerRequestSummary(payload: unknown) {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const messages = Array.isArray(p.messages) ? p.messages : Array.isArray(p.input) ? p.input : [];
  const controls: Record<string, unknown> = {};
  for (const key of ['enable_thinking', 'reasoning_effort', 'max_tokens', 'max_completion_tokens', 'max_output_tokens']) {
    if (typeof p[key] === 'boolean' || typeof p[key] === 'number' || typeof p[key] === 'string') controls[key] = p[key];
  }
  for (const [key, field] of [["thinking", "type"], ["reasoning", "effort"]]) {
    const nested = p[key!];
    if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>)[field!] === "string") controls[`${key}.${field}`] = (nested as Record<string, unknown>)[field!];
  }
  const template = p.chat_template_kwargs;
  if (template && typeof template === 'object' && 'enable_thinking' in template) controls.templateThinking = (template as {enable_thinking: unknown}).enable_thinking;
  const toolConstraints = { strict: 0, nonStrict: 0, unspecified: 0 };
  for (const tool of Array.isArray(p.tools) ? p.tools : []) {
    const declaration = tool?.function ?? tool;
    if (declaration?.strict === true) toolConstraints.strict++;
    else if (declaration?.strict === false) toolConstraints.nonStrict++;
    else toolConstraints.unspecified++;
  }
  const thinkingControl = Object.keys(controls).some(key => /thinking|reasoning/u.test(key)) ? "explicit" : "unspecified";
  return { thinkingControl, toolConstraints, model: typeof p.model === 'string' ? p.model : undefined, messageCount: messages.length, serializedInputChars: JSON.stringify(messages).length, toolCount: Array.isArray(p.tools) ? p.tools.length : 0, controls };
}
