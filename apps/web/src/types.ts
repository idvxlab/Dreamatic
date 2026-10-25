import type { CanvasEdge } from '@dreamatic/project-data/canvas-graph';
export interface SessionView {
  id: string;
  title: string;
  createdAt: string;
  running: boolean;
  messages: unknown[];
  pendingClarification?: ClarificationRequest;
  projectId?: string;
}

export interface ClarificationQuestion {
  id: string;
  header: string;
  question: string;
  options?: Array<{ label: string; description: string }>;
  multiple: boolean;
  custom: boolean;
  placeholder?: string;
  required: boolean;
}

export interface ClarificationRequest {
  id: string;
  title: string;
  context?: string;
  questions: ClarificationQuestion[];
}

export interface Asset {
  path: string;
  kind: string;
  role: "reference" | "generated" | "edited" | "showcase" | "other";
  size: number;
  modifiedAt: string;
  runId?: string;
  label: string;
}

export interface RunView {
  classification?: import('@dreamatic/project-data/project-classification').ProjectClassification;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  stages: Record<string, string>;
  assetCount: number;
  documents: string[];
  notes: Array<{
    id: "intent" | "research" | "plan" | "review";
    title: string;
    text: string;
    path: string;
  }>;
  activity: TimelineItem[];
  agentSessions: AgentSession[];
  modelUsage?: { schemaVersion: 1; reasoning: Array<{ model: string; provider: string; role?: string }>; generation: Array<{ model: string; provider: string; method?: string; deliverableId?: string }> };
  showcasePath?: string;
  presentation?: { mode: "gallery" | "html"; entry: string };
  htmlEntries?: string[];
  hasImageDeliverables?: boolean;
  sessionId?: string;
}

export interface AgentAction {
  id: string;
  tool: string;
  status: "running" | "completed" | "error";
  input?: string;
  output?: string;
  at?: string;
}

export interface AgentSession {
  id: string;
  agent: string;
  title: string;
  status: "running" | "completed" | "interrupted";
  createdAt?: string;
  updatedAt?: string;
  task?: string;
  followUps?: string[];
  output?: string;
  actionCount: number;
  actions: AgentAction[];
  errors: string[];
}

export interface TimelineItem {
  id: string;
  kind: "thought" | "tool" | "result" | "error";
  label: string;
  detail?: string;
  active?: boolean;
  at?: string;
  stage?: string;
  artifactRefs?: string[];
  retryCount?: number;
}

export type WorkflowKind = "message" | "tool" | "agent" | "references" | "milestone" | "retry" | "error";
export type WorkflowStatus = "running" | "completed" | "interrupted" | "waiting" | "error" | "info";

export interface WorkflowEvent {
  id: string;
  kind: WorkflowKind;
  status: WorkflowStatus;
  waitReason?: 'images';
  actor: string;
  label: string;
  detail?: string;
  at?: string;
  endedAt?: string;
  stage?: string;
  tool?: string;
  input?: string;
  output?: string;
  artifactRefs?: string[];
  assets?: Array<{ path: string; label: string }>;
  children?: WorkflowEvent[];
  updatedAt?: string;
  completion?: import("@dreamatic/project-data").CompletionSummary;
  imageProgress?: import("@dreamatic/project-data/workflow-progress").ImageProgress;
  actionCount?: number;
  agent?: string;
}

export interface CanvasElementState {
  id: string;
  kind: "image" | "video" | "html" | "text" | "group" | "prompt";
  x: number;
  y: number;
  width: number;
  height: number;
  assetPath?: string;
  fileId?: string;
  text?: string;
  role?: string;
  taskId?: string;
  outputTaskId?: string;
}

export interface CanvasState {
  version: 1;
  runId: string;
  updatedAt: string;
  camera: { x: number; y: number; zoom: number };
  elements: CanvasElementState[];
  edges?: CanvasEdge[];
  handledTaskIds?: string[];
}

export type WorkbenchView = 'overview' | 'canvas' | 'preview' | 'context' | 'assets' | 'references';
export interface ProjectFile {
  originalName?: string;
  thumbnailUrl?: string;
  id: string;
  title: string;
  kind: string;
  category: 'context' | 'assets' | 'references';
  group: string;
  path?: string;
  url?: string;
  size?: number;
  modifiedAt?: string;
  metadata?: string;
}

export interface ReferenceReaderNode {
  tag: string;
  text?: string;
  href?: string;
  src?: string;
  alt?: string;
  children?: ReferenceReaderNode[];
}
export interface ReferenceArticle {
  title: string;
  url: string;
  byline?: string;
  excerpt?: string;
  nodes: ReferenceReaderNode[];
  embeddingBlocked: boolean;
}
