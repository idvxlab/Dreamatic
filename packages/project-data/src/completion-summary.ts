/** Display/export data only; execution and measurement belong to the server. */
export interface CompletionDeliverable { kind: 'image' | 'page' | 'document'; path: string; label: string }
export interface CompletionStage {
  stage: 'orchestrator' | 'researcher' | 'designer' | 'builder';
  durationMs: number;
  tokens: number;
  attempts: number;
  unreportedCalls: number;
}
export interface CompletionSummary {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  elapsedMs: number;
  executionMs: number;
  pausedMs: number;
  timingIncomplete: boolean;
  tokens: number;
  unreportedCalls: number;
  unreportedImageCalls: number;
  deliverables: CompletionDeliverable[];
  stages: CompletionStage[];
}
