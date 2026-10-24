/** One response at a time. Tool execution never consumes a model response budget. */
export interface ResponseTimerClock {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
export function createModelResponseTimer(options: {
  firstOutputMs: number;
  generationMs: number;
  idleMs?: number;
  totalMs?: number;
  onTimeout: (phase: 'first_output' | 'generation' | 'total' | 'idle') => void;
  clock?: ResponseTimerClock;
}) {
  const clock = options.clock ?? {
    set: (callback: () => void, ms: number) => setTimeout(callback, ms),
    clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let phaseTimer: unknown;
  let totalTimer: unknown;
  let idleTimer: unknown;
  let active = false;
  let hasOutput = false;
  let failure: 'first_output' | 'generation' | 'total' | 'idle' | undefined;
  const stop = () => {
    if (phaseTimer !== undefined) clock.clear(phaseTimer);
    if (totalTimer !== undefined) clock.clear(totalTimer);
    if (idleTimer !== undefined) clock.clear(idleTimer);
    phaseTimer = totalTimer = idleTimer = undefined;
    active = false;
  };
  const expire = (phase: NonNullable<typeof failure>) => {
    if (!active || failure) return;
    failure = phase;
    stop();
    options.onTimeout(phase);
  };
  const start = () => {
    stop();
    if (failure) return;
    active = true;
    hasOutput = false;
    phaseTimer = clock.set(() => expire('first_output'), options.firstOutputMs);
    if (options.totalMs) totalTimer = clock.set(() => expire('total'), options.totalMs);
  };
  return {
    get failure() { return failure; },
    handle(event: { type: string; message?: { role: string }; assistantMessageEvent?: { type: string; delta?: unknown } }) {
      if (event.type === 'turn_start') start();
      // message_start may precede the first token. It must not reset the initial allowance.
      if (event.type === 'message_start' && event.message?.role === 'assistant' && !active && !failure) start();
      if (event.type === 'message_update' && active) {
        const update = event.assistantMessageEvent;
        if (update && (update.type === 'toolcall_start' || (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(update.type) && typeof update.delta === 'string' && update.delta.length > 0))) {
          if (!hasOutput) {
            hasOutput = true;
            if (phaseTimer !== undefined) clock.clear(phaseTimer);
            phaseTimer = clock.set(() => expire('generation'), options.generationMs);
          }
          if (idleTimer !== undefined) clock.clear(idleTimer);
          if (options.idleMs) idleTimer = clock.set(() => expire('idle'), options.idleMs);
        }
      }
      if ((event.type === 'message_end' && event.message?.role === 'assistant') || ['tool_execution_start', 'turn_end', 'agent_end', 'auto_retry_start'].includes(event.type)) stop();
    },
    dispose: stop,
  };
}
