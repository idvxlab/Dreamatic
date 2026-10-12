/** Keep only call metadata; never retain or rewrite source bodies. */
export class SourceWriteRecovery {
  private calls = new Map<string, { missing: string[]; contentChars: number; atOutputLimit: boolean }>();
  clear() { this.calls.clear(); }

  observe(message: { content: unknown[]; usage: { output: number } }, outputLimit?: number) {
    this.clear();
    for (const value of message.content) {
      const call = value as { type?: string; name?: string; id?: string; arguments?: Record<string, unknown> };
      if (call.type !== 'toolCall' || call.name !== 'write' || !call.id) continue;
      const args = call.arguments && typeof call.arguments === 'object' ? call.arguments : {};
      this.calls.set(call.id, {
        missing: ['path', 'content'].filter(key => !(key in args)),
        contentChars: typeof args.content === 'string' ? args.content.length : 0,
        atOutputLimit: !!outputLimit && message.usage.output >= outputLimit,
      });
    }
  }

  summarize(toolCallId: string, raw: string) {
    const call = this.calls.get(toolCallId);
    this.calls.delete(toolCallId);
    if (!raw.startsWith('Validation failed for tool "write":')) return;
    const suspectedTruncation = !!call?.atOutputLimit && !!call.missing.length;
    return {
      ok: false, saved: false,
      code: suspectedTruncation ? 'source_write_output_limit_suspected' : 'source_write_invalid_arguments',
      diagnostic: raw.split('\n\nReceived arguments:')[0]!.slice(0, 1000),
      ...(call ? { missingFields: call.missing, contentChars: call.contentChars } : {}),
      ...(suspectedTruncation ? { outputLimitReached: true, diagnosis: 'Output reached the request limit and required arguments are absent; truncation is suspected, not confirmed by the provider stop reason.' } : {}),
      instruction: suspectedTruncation
        ? 'No file was written. Preserve successful files. Split the failed source into complete local HTML/CSS/JS or content modules, one file per response, with Run-relative path before content. Map all modules in execution.files. Do not resend the whole page or append partial markup.'
        : 'No file was written. Correct the named argument with Run-relative path before complete content. Preserve successful files.',
    };
  }
}
