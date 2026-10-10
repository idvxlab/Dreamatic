import { usePublication } from "./publication-state";
import { useI18n, LanguageToggle } from "./i18n";
import { Upload, Grid2X2, Menu, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { abortSession, createSession, deleteRun, getHealth, getRuntimeConfig, openProjectAssets, getWorkflow, getRun, listRunAssets, listAssets, listRuns, listSessions, renameRun, saveRuntimeConfig, streamPrompt, streamWorkflow, type HealthView, type PromptEvent, type RuntimeConfig } from "./api";
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
  export_package: "Preparing the final preview",
};

function liveToolLabel(name: string): string {
  return LIVE_TOOL_LABELS[name] ?? name.replaceAll("_", " ").replace(/^./u, (letter) => letter.toUpperCase());
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}


export function App() {
  const { t } = useI18n();
  const initialized = useRef(false);
  const workspaceReady = useRef(false);
  const selectionEpoch = useRef(0);
  const promptRequests = useRef(new Map<string, symbol>());
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [selection, setSelection] = useState<{ runId?: string | undefined; sessionId?: string | undefined }>({});
  const selectedView = useRef(selection);
  selectedView.current = selection;
  const activateSelection = (next: typeof selection) => { selectedView.current = next; setSelection(next); };
  const activeId = selection.sessionId;
  const activeRunId = selection.runId;
  const [runs, setRuns] = useState<RunView[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [workflow, setWorkflow] = useState<WorkflowEvent[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<string>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const textBuffer = useRef("");
  const textTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const resetStreamingText = () => { if (textTimer.current) clearTimeout(textTimer.current); textTimer.current = undefined; textBuffer.current = ""; setStreamingText(""); };
  const appendStreamingText = (delta: string) => {
    textBuffer.current += delta;
    if (!textTimer.current) textTimer.current = setTimeout(() => { const text = textBuffer.current; textBuffer.current = ""; textTimer.current = undefined; setStreamingText((current) => current + text); }, 60);
  };
  useEffect(() => () => { if (textTimer.current) clearTimeout(textTimer.current); }, []);
  const [runningSessions, setRunningSessions] = useState<Set<string>>(new Set());
  const [stoppingSessions, setStoppingSessions] = useState<Set<string>>(new Set());
  const stopping = Boolean(activeId && stoppingSessions.has(activeId));
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
  const [openingAssets, setOpeningAssets] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState<RuntimeConfig>();
  const [notice, setNotice] = useState<string>();

  const active = useMemo(() => sessions.find((session) => session.id === activeId), [sessions, activeId]);
  const activeRun = useMemo(() => runs.find((run) => run.id === activeRunId), [runs, activeRunId]);
  const publication = usePublication(activeRun?.id);
  const publicationLabel = !activeRun ? "No project" : publication.error ? "Publication status unavailable" : !publication.status ? "Checking publication…" : publication.status.inProgress ? "Publishing…" : publication.status.published ? "Published" : publication.status.mayExist ? "Publication unconfirmed" : "Not published";
  const agentRunning = Boolean(activeId && runningSessions.has(activeId)) || Boolean(active?.running);
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
        const next = existing;
        const existingRuns = loadedRuns;
        setSessions(next);
        setRuns(existingRuns);
        setSelection(current => {
          const run = existingRuns.find(run => run.id === current.runId) ?? existingRuns[0];
          const session = next.find(session => session.id === current.sessionId && (session.projectId === run?.id || session.id === run?.sessionId))
            ?? next.find(session => session.id === run?.sessionId || session.projectId === run?.id);
          return { runId: run?.id, sessionId: session?.id };
        });
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
    let disposed = false;
    let fetching = false;
    let timer: ReturnType<typeof setTimeout>;
    const epoch = selectionEpoch.current;
    const refresh = async () => {
      if (disposed || fetching) return;
      fetching = true;
      try {
        const [nextRuns, nextAssets, nextSessions, detail] = await Promise.all([
          listRuns(), activeRunId ? listRunAssets(activeRunId) : listAssets(), listSessions(),
          activeRunId ? getRun(activeRunId).catch(() => undefined) : Promise.resolve(undefined),
        ]);
        if (disposed || epoch !== selectionEpoch.current) return;
        const recovering = !workspaceReady.current;
        setRuns(nextRuns.map((run) => run.id === detail?.id ? detail : run));
        setAssets(nextAssets);
        setSessions(nextSessions);
        setSelection(current => {
          const run = nextRuns.find(run => run.id === current.runId) ?? (current.runId || recovering ? nextRuns[0] : undefined);
          const session = run ? nextSessions.find(session => session.id === current.sessionId && (session.projectId === run.id || session.id === run.sessionId))
            ?? nextSessions.find(session => session.id === run.sessionId || session.projectId === run.id) : undefined;
          return { runId: run?.id, sessionId: session?.id };
        });
        workspaceReady.current = true;
        setConnectionError(undefined);
        setLoading(false);
      } catch (error) { if (!disposed && epoch === selectionEpoch.current) setConnectionError(error instanceof Error ? error.message : String(error)); }
      finally {
        fetching = false;
        if (!disposed) timer = setTimeout(() => void refresh(), document.hidden ? 60_000 : agentRunning ? 3_000 : 15_000);
      }
    };
    const wake = () => { clearTimeout(timer); void refresh(); };
    void refresh();
    document.addEventListener("visibilitychange", wake);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [activeId, activeRunId, agentRunning]);

  useEffect(() => {
    if (!activeRunId) {
      setWorkflow([]);
      return;
    }
    let disposed = false;
    setWorkflow([]);
    const epoch = selectionEpoch.current;
    const closeStream = streamWorkflow(activeRunId, (message) => {
      if (disposed || epoch !== selectionEpoch.current) return;
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
    if (creating) return;
    const epoch = selectionEpoch.current;
    setCreating(true);
    try {
      const session = await createSession();
      const nextRuns = await listRuns();
      setSessions((current) => [session, ...current]);
      setRuns(nextRuns);
      if (epoch !== selectionEpoch.current) return;
      selectionEpoch.current += 1;
      activateSelection({ runId: session.projectId, sessionId: session.id });
      setWorkflow([]);
      setTimeline([]);
      resetStreamingText();
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
    const epoch = ++selectionEpoch.current;
    setWorkflow([]);
    setTimeline([]);
    resetStreamingText();
    setPendingAgentStatus(undefined);
    setLiveClarification(undefined);
    setAnsweredClarificationId(undefined);
    setSelectedAsset(undefined);
    const project = runs.find((run) => run.id === runId);
    const linked = project?.sessionId ? sessions.find((session) => session.id === project.sessionId) : undefined;
    activateSelection({ runId, sessionId: linked?.id });
    if (!linked && project) {
      try {
        const session = await createSession(project.id, project.title);
        setSessions((current) => [session, ...current]);
        setRuns((current) => current.map((run) => run.id === project.id ? { ...run, sessionId: session.id } : run));
        if (epoch === selectionEpoch.current) activateSelection({ runId: project.id, sessionId: session.id });
      } catch (error) {
        if (epoch === selectionEpoch.current) setConnectionError(error instanceof Error ? error.message : String(error));
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
      if (selectedView.current.runId === runId) { selectionEpoch.current += 1; resetStreamingText(); setTimeline([]); setPendingAgentStatus(undefined); activateSelection({ runId: nextRuns[0]?.id, sessionId: nextRuns[0]?.sessionId }); }
      setNotice("Project moved to local Trash");
      window.setTimeout(() => setNotice(undefined), 2600);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openSettings() {
    try {
      setRuntimeConfig(await getRuntimeConfig());
      setNavigationOpen(false);
      setSettingsOpen(true);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    }
  }

  async function openAssetsFolder() {
    if (!activeRunId || openingAssets) return;
    setOpeningAssets(true);
    try { await openProjectAssets(activeRunId); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not open project folder"); window.setTimeout(() => setNotice(undefined), 5000); }
    finally { setOpeningAssets(false); }
  }

  async function saveSettings(config: RuntimeConfig & { textApiKey?: string; searchApiKey?: string; imageApiKey?: string }) {
    const saved = await saveRuntimeConfig(config);
    setRuntimeConfig(saved);
    if (saved.applied?.portChanged) {
      const target = new URL(window.location.href); target.port = String(saved.applied.port);
      window.location.assign(target.href); return;
    }
    if (saved.applied?.workspaceChanged) { window.location.reload(); return; }
    setHealth(await getHealth());
    void publication.refresh();
    setSettingsOpen(false);
    setNotice("Settings saved and applied");
    window.setTimeout(() => setNotice(undefined), 2200);
  }

  function receive(item: PromptEvent) {
    if (item.type === "error") {
      setPendingAgentStatus(undefined);
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "error", label: t("Run failed"), detail: item.message }]);
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
        appendStreamingText(update.delta);
      }
      return;
    }
    if (type === "tool_execution_start") {
      setPendingAgentStatus(undefined);
      resetStreamingText();
      const label = typeof event.toolName === "string" ? event.toolName : t("Using tool");
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
    if (!activeId || !activeRun || promptRequests.current.has(activeId)) return;
    const sessionId = activeId, runId = activeRun.id;
    const requestId = Symbol(sessionId);
    promptRequests.current.set(sessionId, requestId);
    const ownsView = () => selectedView.current.runId === runId && selectedView.current.sessionId === sessionId && promptRequests.current.get(sessionId) === requestId;
    setRunningSessions(current => new Set(current).add(sessionId));
    resetStreamingText();
    const userText = presentation?.userText ?? text;
    setPendingAgentStatus(presentation?.waitingLabel ?? (activeRun?.status === "draft" ? "正在理解设计需求，并判断是否需要进一步澄清…" : "正在理解你的消息并决定下一步…"));
    setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "thought", label: userText, detail: images.length ? `${images.length} reference image${images.length > 1 ? "s" : ""}` : undefined }]);
    if (activeRunId) {
      const localMessage: WorkflowEvent = {
        id: `local-user-${crypto.randomUUID()}`,
        kind: "message",
        status: "completed",
        actor: "User",
        label: t("You"),
        detail: userText,
        at: new Date().toISOString(),
      };
      setWorkflow((current) => [...current, localMessage]);
    }
    try {
      await streamPrompt(sessionId, text, images.map(({ name, data, mimeType }) => ({ name, data, mimeType })), item => {
        if (item.type === "snapshot" && item.session) setSessions(current => current.map(session => session.id === item.session?.id ? item.session : session));
        else if (ownsView()) receive(item);
      }, runId);
      const [nextRuns, nextAssets, persistedWorkflow, detail] = await Promise.all([
        listRuns(),
        listRunAssets(runId),
        getWorkflow(runId),
        getRun(runId).catch(() => undefined),
      ]);
      if (!ownsView()) return;
      setRuns(nextRuns.map((run) => run.id === detail?.id ? detail : run));
      setAssets(nextAssets);
      if (persistedWorkflow) setWorkflow(persistedWorkflow);
    } catch (error) {
      if (ownsView()) setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "error", label: t("Connection interrupted"), detail: error instanceof Error ? error.message : String(error) }]);
    } finally {
      if (ownsView()) { setPendingAgentStatus(undefined); resetStreamingText(); }
      if (promptRequests.current.get(sessionId) === requestId) {
        promptRequests.current.delete(sessionId);
        setRunningSessions(current => { const next = new Set(current); next.delete(sessionId); return next; });
      }
    }
  }

  async function stopAgent() {
    if (!activeId || !agentRunning || stopping) return;
    const sessionId = activeId;
    setStoppingSessions(current => new Set(current).add(sessionId));
    try {
      const result = await abortSession(sessionId);
      if (selectedView.current.sessionId === sessionId) setPendingAgentStatus(undefined);
      setNotice(result.interrupted ? "Stopping the current run…" : "The run has already stopped");
      window.setTimeout(() => setNotice(undefined), 2200);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setStoppingSessions(current => { const next = new Set(current); next.delete(sessionId); return next; });
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
          <div><button className="navigation-trigger" aria-label={t("Open project navigation")} aria-controls="project-panel" onClick={() => setNavigationOpen(true)}><Menu size={17} /></button><button className="sidebar-toggle" aria-label={projectPanelOpen ? t("Hide project panel") : t("Show project panel")} aria-controls="project-panel" aria-expanded={projectPanelOpen} title={projectPanelOpen ? t("Hide project panel") : t("Show project panel")} onClick={() => setProjectPanelOpen((open) => !open)}>{projectPanelOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button><span className="project-kicker">{t("Project")}</span><h2>{activeRun?.title ?? active?.title ?? (loading ? t("Connecting…") : t("Design workspace"))}</h2></div>
          <div className="header-actions"><span className="saved publication-status" role="status" title={t(publicationLabel)}><Upload size={14} /> {t(publicationLabel)}</span><button disabled={!activeRunId || openingAssets} title={t("Open project assets folder")} onClick={() => void openAssetsFolder()}><Grid2X2 size={15} /> {t("Assets")} <em>{visibleAssets.length}</em></button><LanguageToggle /><button className="icon-button" title={panelOpen ? t("Hide agent panel") : t("Show agent panel")} onClick={() => setPanelOpen((open) => !open)}>{panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button></div>
        </header>
        <Canvas assets={visibleAssets} selected={selectedAsset} onSelect={setSelectedAsset} run={activeRun} />

      </section>
      {panelOpen && <AgentPanel connected={Boolean(health?.ok && !connectionError)} disabled={!activeRun || !activeId || loading || creating} timeline={activeRun?.activity ?? timeline} workflow={activeRun ? workflow : []} streamingText={streamingText} running={agentRunning} stopping={stopping} pendingAgentStatus={pendingAgentStatus} clarification={visibleClarification} onSend={send} onStop={() => void stopAgent()} onAnswerClarification={answerClarification} onDismissClarification={() => { if (visibleClarification) setAnsweredClarificationId(visibleClarification.id); setLiveClarification(undefined); }} />}
      {navigationOpen && <button className="navigation-scrim" aria-label={t("Close project navigation")} onClick={() => setNavigationOpen(false)} />}
      {panelOpen && <button className="agent-scrim" aria-label={t("Close agent panel")} onClick={() => setPanelOpen(false)} />}
      {connectionError && <div className="connection-banner"><span><strong>{t("Server unavailable")}</strong><small>{connectionError}</small></span><button onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} /> {loading ? t("Connecting…") : t("Reconnect")}</button></div>}
      {notice && <div className="toast">{t(notice)}</div>}
      {settingsOpen && runtimeConfig && <SettingsModal initial={runtimeConfig} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
    </div>
  );
}
