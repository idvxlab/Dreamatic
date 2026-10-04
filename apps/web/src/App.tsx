import { Cloud, Grid2X2, Menu, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw, Share2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { abortSession, createSession, deleteRun, getHealth, getRuntimeConfig, getWorkflow, listAssets, listRuns, listSessions, renameRun, saveRuntimeConfig, streamPrompt, streamWorkflow, type HealthView, type PromptEvent, type RuntimeConfig } from "./api";
import { AgentPanel, type PendingImage } from "./components/AgentPanel";
import { Canvas } from "./components/Canvas";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import type { Asset, ClarificationRequest, RunView, SessionView, TimelineItem, WorkflowEvent } from "./types";
import { applyWorkflowStreamEvent } from "./workflow-live";
import { clarificationFromToolResult } from "../../../packages/design-agent/src/clarification";

function eventName(event: Record<string, unknown>): string {
  return typeof event.type === "string" ? event.type : "agent_event";
}

const LIVE_TOOL_LABELS: Record<string, string> = {
  ask_user: "Clarifying the brief",
  run_init: "Creating the design project",
  todo_write: "Planning the workflow",
  spawn_agent: "Starting a specialist agent",
  design_bus_read: "Reading workflow context",
  design_bus_post: "Updating workflow progress",
  artifact_lint: "Checking design deliverables",
  export_package: "Preparing the final showcase",
};

function liveToolLabel(name: string): string {
  return LIVE_TOOL_LABELS[name] ?? name.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}


export function App() {
  const initialized = useRef(false);
  const workspaceReady = useRef(false);
  const awaitingRun = useRef(false);
  const runIdsBeforePrompt = useRef<Set<string>>(new Set());
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [runs, setRuns] = useState<RunView[]>([]);
  const [activeRunId, setActiveRunId] = useState<string>();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowEvent[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [pendingAgentStatus, setPendingAgentStatus] = useState<string>();
  const [liveClarification, setLiveClarification] = useState<{ sessionId: string; request: ClarificationRequest }>();
  const [answeredClarificationId, setAnsweredClarificationId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [health, setHealth] = useState<HealthView>();
  const [panelOpen, setPanelOpen] = useState(true);
  const [projectPanelOpen, setProjectPanelOpen] = useState(true);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>();
  const [notice, setNotice] = useState<string>();

  const active = useMemo(() => sessions.find((session) => session.id === activeId), [sessions, activeId]);
  const activeRun = useMemo(() => runs.find((run) => run.id === activeRunId), [runs, activeRunId]);
  const agentRunning = running || Boolean(active?.running);
  const pendingClarification = liveClarification && liveClarification.sessionId === activeId ? liveClarification.request : active?.pendingClarification;
  const visibleClarification = pendingClarification?.id === answeredClarificationId ? undefined : pendingClarification;
  const visibleAssets = useMemo(
    () => activeRunId ? assets.filter((asset) => asset.path.startsWith(`runs/${activeRunId}/`)) : assets,
    [activeRunId, assets],
  );

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setConnectionError(undefined);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const [existing, loadedRuns, initialAssets, runtimeHealth] = await Promise.all([listSessions(), listRuns(), listAssets(), getHealth()]);
        const next = existing.length > 0 ? existing : [await createSession()];
        const existingRuns = existing.length > 0 ? loadedRuns : await listRuns();
        setSessions(next);
        setRuns(existingRuns);
        setActiveRunId((current) => current && existingRuns.some((run) => run.id === current) ? current : existingRuns[0]?.id);
        setActiveId((current) => current && next.some((session) => session.id === current)
          ? current
          : next.find((session) => session.id === existingRuns[0]?.sessionId)?.id ?? next[0]?.id);
        setAssets(initialAssets);
        setHealth(runtimeHealth);
        workspaceReady.current = true;
        setLoading(false);
        return;
      } catch (error) {
        if (attempt < 19) {
          await pause(500);
          continue;
        }
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void Promise.all([listRuns(), listAssets(), listSessions()]).then(([nextRuns, nextAssets, nextSessions]) => {
        const recovering = !workspaceReady.current;
        setRuns(nextRuns);
        setAssets(nextAssets);
        setSessions(nextSessions);
        setActiveRunId((current) => {
          if (current && nextRuns.some((run) => run.id === current)) return current;
          if (current || recovering) return nextRuns[0]?.id;
          return undefined;
        });
        setActiveId((current) => {
          if (current && nextSessions.some((session) => session.id === current)) return current;
          if (!current && !recovering) return undefined;
          const firstRun = nextRuns[0];
          return nextSessions.find((session) => session.id === firstRun?.sessionId)?.id ?? nextSessions[0]?.id;
        });
        workspaceReady.current = true;
        setConnectionError(undefined);
        setLoading(false);
        if (awaitingRun.current) {
          const owned = nextRuns.find((run) => run.sessionId === activeId);
          const created = nextRuns.find((run) => !runIdsBeforePrompt.current.has(run.id) && run.sessionId === activeId);
          if (owned || created) {
            setActiveRunId((owned ?? created)!.id);
            awaitingRun.current = false;
          }
        }
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeId]);

  useEffect(() => {
    if (!activeRunId) {
      setWorkflow([]);
      return;
    }
    let disposed = false;
    setWorkflow([]);
    void getWorkflow(activeRunId).then((next) => {
      if (!disposed) setWorkflow(next);
    }).catch(() => undefined);
    const closeStream = streamWorkflow(activeRunId, (message) => {
      if (disposed) return;
      if (message.type === "snapshot") setWorkflow(message.workflow);
      else {
        setPendingAgentStatus(undefined);
        setWorkflow((current) => applyWorkflowStreamEvent(current, message.event));
      }
    });
    return () => {
      disposed = true;
      closeStream();
    };
  }, [activeRunId]);

  async function addSession() {
    setCreating(true);
    try {
      const session = await createSession();
      const nextRuns = await listRuns();
      setSessions((current) => [session, ...current]);
      setRuns(nextRuns);
      setActiveId(session.id);
      setActiveRunId(session.projectId);
      setWorkflow([]);
      setTimeline([]);
      setStreamingText("");
      setLiveClarification(undefined);
      setAnsweredClarificationId(undefined);
      setPendingAgentStatus(undefined);
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
    }
  }

  async function renameProject(runId: string, title: string) {
    try {
      await renameRun(runId, title);
      setRuns((current) => current.map((run) => run.id === runId ? { ...run, title } : run));
      setNotice("Project renamed");
      window.setTimeout(() => setNotice(undefined), 2200);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function selectProject(runId: string) {
    if (runId === activeRunId) {
      setNavigationOpen(false);
      return;
    }
    setWorkflow([]);
    setTimeline([]);
    setStreamingText("");
    setPendingAgentStatus(undefined);
    setLiveClarification(undefined);
    setAnsweredClarificationId(undefined);
    setSelectedAsset(undefined);
    setActiveRunId(runId);
    const project = runs.find((run) => run.id === runId);
    const linked = project?.sessionId ? sessions.find((session) => session.id === project.sessionId) : undefined;
    if (linked) {
      setActiveId(linked.id);
    } else if (project) {
      try {
        const session = await createSession(project.id, project.title);
        setSessions((current) => [session, ...current]);
        setRuns((current) => current.map((run) => run.id === project.id ? { ...run, sessionId: session.id } : run));
        setActiveId(session.id);
      } catch (error) {
        setConnectionError(error instanceof Error ? error.message : String(error));
      }
    }
    setNavigationOpen(false);
  }

  async function deleteProject(runId: string) {
    try {
      await deleteRun(runId);
      const [nextRuns, nextAssets] = await Promise.all([listRuns(), listAssets()]);
      setRuns(nextRuns);
      setAssets(nextAssets);
      if (activeRunId === runId) setActiveRunId(nextRuns[0]?.id);
      setNotice("Project moved to local Trash");
      window.setTimeout(() => setNotice(undefined), 2600);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function shareWorkspace() {
    await navigator.clipboard.writeText(window.location.href);
    setNotice("Local workspace link copied");
    window.setTimeout(() => setNotice(undefined), 2200);
  }

  async function openSettings() {
    try {
      setRuntimeConfig(await getRuntimeConfig());
      setSettingsOpen(true);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveSettings(config: RuntimeConfig & { textApiKey?: string; searchApiKey?: string; imageApiKey?: string }) {
    const saved = await saveRuntimeConfig(config);
    setRuntimeConfig(saved);
    setHealth(await getHealth());
    setSettingsOpen(false);
    setNotice("Agent configuration saved");
    window.setTimeout(() => setNotice(undefined), 2200);
  }

  function receive(item: PromptEvent) {
    if (item.type === "error") {
      setPendingAgentStatus(undefined);
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "error", label: "Run failed", detail: item.message }]);
      return;
    }
    if (item.type === "snapshot" && item.session) {
      setSessions((current) => current.map((session) => session.id === item.session?.id ? item.session : session));
      return;
    }
    if (!item.event) return;
    const event = item.event;
    const type = eventName(event);
    if (type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update && typeof update === "object" && "type" in update && update.type === "text_delta" && "delta" in update && typeof update.delta === "string") {
        setPendingAgentStatus(undefined);
        setStreamingText((current) => current + update.delta);
      }
      return;
    }
    if (type === "tool_execution_start") {
      setPendingAgentStatus(undefined);
      setStreamingText("");
      const label = typeof event.toolName === "string" ? event.toolName : "Using tool";
      const id = String(event.toolCallId ?? crypto.randomUUID());
      setTimeline((current) => [...current, { id, kind: "tool", label, active: true }]);
      setWorkflow((current) => current.some((entry) => entry.id === id) ? current : [...current, {
        id,
        kind: "tool",
        status: "running",
        actor: "Orchestrator",
        label: liveToolLabel(label),
        tool: label,
        at: new Date().toISOString(),
      }]);
    } else if (type === "tool_execution_end") {
      const id = String(event.toolCallId ?? "");
      if (event.toolName === "ask_user" && event.isError !== true && activeId) {
        const request = clarificationFromToolResult(event.result, id);
        if (request) setLiveClarification((current) => current?.sessionId === activeId ? current : { sessionId: activeId, request });
      }
      setTimeline((current) => current.map((entry) => entry.id === id ? { ...entry, active: false, kind: "result" } : entry));
      setWorkflow((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        status: event.isError === true ? "error" : "completed",
        endedAt: new Date().toISOString(),
      } : entry));
    }
  }

  async function send(text: string, images: PendingImage[], presentation?: { userText?: string; waitingLabel?: string }) {
    if (!activeId) return;
    setRunning(true);
    awaitingRun.current = true;
    runIdsBeforePrompt.current = new Set(runs.map((run) => run.id));
    setStreamingText("");
    const userText = presentation?.userText ?? text;
    setPendingAgentStatus(presentation?.waitingLabel ?? (activeRun?.status === "draft" ? "正在理解设计需求，并判断是否需要进一步澄清…" : "正在理解你的消息并决定下一步…"));
    setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "thought", label: userText, detail: images.length ? `${images.length} reference image${images.length > 1 ? "s" : ""}` : undefined }]);
    if (activeRunId) {
      const localMessage: WorkflowEvent = {
        id: `local-user-${crypto.randomUUID()}`,
        kind: "message",
        status: "completed",
        actor: "User",
        label: "You",
        detail: userText,
        at: new Date().toISOString(),
      };
      setWorkflow((current) => [...current, localMessage]);
    }
    try {
      await streamPrompt(activeId, text, images.map(({ name, data, mimeType }) => ({ name, data, mimeType })), receive, activeRunId);
      const [nextRuns, nextAssets, persistedWorkflow] = await Promise.all([
        listRuns(),
        listAssets(),
        activeRunId ? getWorkflow(activeRunId) : Promise.resolve(undefined),
      ]);
      setRuns(nextRuns);
      setAssets(nextAssets);
      if (persistedWorkflow) setWorkflow(persistedWorkflow);
      const ownedRun = nextRuns.find((run) => run.sessionId === activeId);
      if (ownedRun) setActiveRunId(ownedRun.id);
    } catch (error) {
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "error", label: "Connection interrupted", detail: error instanceof Error ? error.message : String(error) }]);
    } finally {
      awaitingRun.current = false;
      setRunning(false);
      setPendingAgentStatus(undefined);
      setStreamingText("");
    }
  }

  async function stopAgent() {
    if (!activeId || !agentRunning || stopping) return;
    setStopping(true);
    try {
      const result = await abortSession(activeId);
      setPendingAgentStatus(undefined);
      setNotice(result.interrupted ? "Stopping the current run…" : "The run has already stopped");
      window.setTimeout(() => setNotice(undefined), 2200);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStopping(false);
    }
  }

  function answerClarification(answers: Record<string, string>) {
    if (!visibleClarification) return;
    const response = visibleClarification.questions
      .map((question) => `${question.header}｜${question.question}\n${answers[question.id]?.trim() || "采用合理默认值"}`)
      .join("\n\n");
    setAnsweredClarificationId(visibleClarification.id);
    setLiveClarification(undefined);
    const answerMessage = `我的回答：\n\n${response}\n\n请据此继续。`;
    void send(answerMessage, [], {
      userText: answerMessage,
      waitingLabel: "正在整理你的答案，并规划接下来的设计工作流…",
    });
  }

  return (
    <div className={`app-shell ${panelOpen ? "panel-open" : "panel-collapsed"} ${projectPanelOpen ? "sidebar-open" : "sidebar-collapsed"} ${navigationOpen ? "navigation-open" : ""}`}>
      <Sidebar
        runs={runs}
        activeRunId={activeRunId}
        onCreate={() => void addSession()}
        onSelectRun={(id) => { setNavigationOpen(false); void selectProject(id); }}
        onRenameRun={(id, title) => void renameProject(id, title)}
        onDeleteRun={(id) => void deleteProject(id)}
        onSettings={() => void openSettings()}
        creating={creating}
      />
      <section className="workspace">
        <header className="workspace-header">
          <div><button className="navigation-trigger" aria-label="Open project navigation" aria-controls="project-panel" onClick={() => setNavigationOpen(true)}><Menu size={17} /></button><button className="sidebar-toggle" aria-label={projectPanelOpen ? "Hide project panel" : "Show project panel"} aria-controls="project-panel" aria-expanded={projectPanelOpen} title={projectPanelOpen ? "Hide project panel" : "Show project panel"} onClick={() => setProjectPanelOpen((open) => !open)}>{projectPanelOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button><span className="project-kicker">Project</span><h2>{activeRun?.title ?? active?.title ?? (loading ? "Connecting…" : "Design workspace")}</h2></div>
          <div className="header-actions"><span className="saved"><Cloud size={14} /> Saved locally</span><button className={assetsOpen ? "active" : ""} onClick={() => setAssetsOpen((open) => !open)}><Grid2X2 size={15} /> Assets <em>{visibleAssets.length}</em></button><button onClick={() => void shareWorkspace()}><Share2 size={15} /> Share</button><button className="icon-button" title={panelOpen ? "Hide agent panel" : "Show agent panel"} onClick={() => setPanelOpen((open) => !open)}>{panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button></div>
        </header>
        <Canvas assets={visibleAssets} selected={selectedAsset} onSelect={setSelectedAsset} run={activeRun} />
        {assetsOpen && (
          <aside className="asset-drawer">
            <header><div><Grid2X2 size={16} /><span><strong>Project assets</strong><small>{visibleAssets.length} files in this project</small></span></div><button title="Close assets" onClick={() => setAssetsOpen(false)}><X size={15} /></button></header>
            <div>{visibleAssets.length === 0 ? <p>No generated assets yet. Start a design run to create them.</p> : visibleAssets.map((asset) => <button key={asset.path} onClick={() => { setSelectedAsset(asset.path); setAssetsOpen(false); }}><span>{asset.path.split("/").at(-1)}</span><small>{asset.kind.toUpperCase()} · {Math.max(1, Math.round(asset.size / 1024))} KB</small></button>)}</div>
          </aside>
        )}
      </section>
      {panelOpen && <AgentPanel timeline={activeRun?.activity ?? timeline} workflow={activeRun ? workflow : []} streamingText={streamingText} running={agentRunning} stopping={stopping} pendingAgentStatus={pendingAgentStatus} clarification={visibleClarification} onSend={send} onStop={() => void stopAgent()} onAnswerClarification={answerClarification} onDismissClarification={() => { if (visibleClarification) setAnsweredClarificationId(visibleClarification.id); setLiveClarification(undefined); }} />}
      {navigationOpen && <button className="navigation-scrim" aria-label="Close project navigation" onClick={() => setNavigationOpen(false)} />}
      {panelOpen && <button className="agent-scrim" aria-label="Close agent panel" onClick={() => setPanelOpen(false)} />}
      {connectionError && <div className="connection-banner"><span><strong>Server unavailable</strong><small>{connectionError}</small></span><button onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} /> {loading ? "Connecting…" : "Reconnect"}</button></div>}
      {notice && <div className="toast">{notice}</div>}
      {settingsOpen && runtimeConfig && <SettingsModal initial={runtimeConfig} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
    </div>
  );
}
