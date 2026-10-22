export interface DesignClarificationRequest {
  id: string;
  title: string;
  context?: string;
  questions: Array<{
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }>;
    multiple: boolean;
    custom: boolean;
    placeholder?: string;
    required: boolean;
  }>;
}

export function clarificationFromToolResult(result: unknown, toolCallId: string): DesignClarificationRequest | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result) || !toolCallId) return undefined;
  const record = result as Record<string, unknown>;
  if (record.isError === true || !Array.isArray(record.content)) return undefined;
  for (const block of record.content) {
    if (!block || typeof block !== "object" || block.type !== "text" || typeof block.text !== "string") continue;
    let data: Record<string, unknown>;
    try { data = JSON.parse(block.text); } catch { continue; }
    if (!data || data.status !== "waiting_for_user" || !Array.isArray(data.questions) || data.questions.length < 1) continue;
    const questions: DesignClarificationRequest["questions"] = [];
    for (const [index, raw] of data.questions.entries()) {
      if (!raw || typeof raw !== "object" || typeof raw.question !== "string" || !raw.question.trim() || typeof raw.header !== "string") return undefined;
      const options: Array<{ label: string; description: string } | undefined> | undefined = Array.isArray(raw.options) ? raw.options.map((option: unknown) => {
        if (!option || typeof option !== "object") return undefined;
        const value = option as Record<string, unknown>;
        return typeof value.label === "string" && typeof value.description === "string" ? { label: value.label, description: value.description } : undefined;
      }) : undefined;
      if (options && (options.length < 2 || options.length > 4 || options.some((option) => !option))) return undefined;
      questions.push({
        id: typeof raw.id === "string" ? raw.id : `question-${index + 1}`,
        header: raw.header, question: raw.question,
        ...(options ? { options: options.filter((option): option is { label: string; description: string } => !!option) } : {}),
        multiple: raw.multiple === true, custom: raw.custom !== false,
        required: raw.required !== false,
        ...(typeof raw.placeholder === "string" ? { placeholder: raw.placeholder } : {}),
      });
    }
    if (new Set(questions.map((question) => question.id)).size !== questions.length) return undefined;
    return { id: toolCallId, title: typeof data.title === "string" ? data.title : "A few details before we begin", ...(typeof data.context === "string" ? { context: data.context } : {}), questions };
  }
  return undefined;
}
