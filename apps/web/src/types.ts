export interface SessionView {
  id: string;
  title: string;
  createdAt: string;
  running: boolean;
  messages: unknown[];
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
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: string;
  stages: Record<string, string>;
  assetCount: number;
  documents: string[];
  notes: Array<{
    id: "research" | "plan" | "critique";
    title: string;
    text: string;
    path: string;
  }>;
  activity: TimelineItem[];
  showcasePath?: string;
  sessionId?: string;
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

export interface CanvasElementState {
  id: string;
  kind: "image" | "text" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  assetPath?: string;
  text?: string;
  role?: string;
}

export interface CanvasState {
  version: 1;
  runId: string;
  updatedAt: string;
  camera: { x: number; y: number; zoom: number };
  elements: CanvasElementState[];
}
