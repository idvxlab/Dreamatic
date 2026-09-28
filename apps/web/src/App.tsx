import { Cloud, Grid2X2, Menu, PanelRightClose, PanelRightOpen, RefreshCw, Share2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { abortSession, createSession, deleteRun, getHealth, getRuntimeConfig, getWorkflow, listAssets, listRuns, listSessions, renameRun, saveRuntimeConfig, streamPrompt, streamWorkflow, type HealthView, type PromptEvent, type RuntimeConfig } from "./api";
import { AgentPanel, type PendingImage } from "./components/AgentPanel";
import { Canvas } from "./components/Canvas";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import type { Asset, ClarificationRequest, RunView, SessionView, TimelineItem, WorkflowEvent } from "./types";
import { applyWorkflowStreamEvent } from "./workflow-live";

function eventName(event: Record<string, unknown>): string {
  return typeof event.type === "string" ? event.type : "agent_event";
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function clarificationFromEvent(event: Record<string, unknown>): ClarificationRequest | undefined {
  if (event.toolName !== "ask_user" || !event.args || typeof event.args !== "object" || Array.isArray(event.args)) return undefined;
  const args = event.args as Record<string, unknown>;
  if (!Array.isArray(args.questions)) return undefined;
  const questions = args.questions.flatMap((raw, index): ClarificationRequest["questions"] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const question = raw as Record<string, unknown>;
    const prompt = typeof question.question === "string" ? question.question : typeof question.prompt === "string" ? question.prompt : undefined;
    if (!prompt) return [];
    const options = Array.isArray(question.options) ? question.options.flatMap((rawOption): Array<{ label: string; description: string }> => {
      if (typeof rawOption === "string") return [{ label: rawOption, description: rawOption }];
      if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return [];
      const option = rawOption as Record<string, unknown>;
      return typeof option.label === "string" ? [{ label: option.label, description: typeof option.description === "string" ? option.description : option.label }] : [];
    }) : undefined;
    return [{ id: typeof question.id === "string" ? question.id : `question-${index + 1}`, header: typeof question.header === "string" ? question.header : `Question ${index + 1}`, question: prompt, ...(options?.length ? { options } : {}), multiple: question.multiple === true, custom: question.custom !== false, ...(typeof question.placeholder === "string" ? { placeholder: question.placeholder } : {}), required: question.required !== false }];
  });
  if (!questions.length) return undefined;
  return { id: String(event.toolCallId ?? crypto.randomUUID()), title: typeof args.title === "string" ? args.title : "A few details before we begin", ...(typeof args.context === "string" ? { context: args.context } : {}), questions };
}

export function App() {
  const initialized = useRef(false);
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
  const [liveClarification, setLiveClarification] = useState<{ sessionId: string; request: ClarificationRequest }>();
  const [answeredClarificationId, setAnsweredClarificationId] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [connectionError, setConnectionError] = useState<string>();
  const [health, setHealth] = useState<HealthView>();
  const [panelOpen, setPanelOpen] = useState(true);
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
    for (let attempt = 0; attempt < 8; attempt += 1) {
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
        setLoading(false);
        return;
      } catch (error) {
        if (attempt < 7) {
          await pause(350);
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
        setRuns(nextRuns);
        setAssets(nextAssets);
        setSessions(nextSessions);
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
    void getWorkflow(activeRunId).then((next) => {
      if (!disposed) setWorkflow(next);
    }).catch(() => undefined);
    const closeStream = streamWorkflow(activeRunId, (message) => {
      if (disposed) return;
      if (message.type === "snapshot") setWorkflow(message.workflow);
      else setWorkflow((current) => applyWorkflowStreamEvent(current, message.event));
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

  async function saveSettings(config: RuntimeConfig & { textApiKey?: string; imageApiKey?: string }) {
    const saved = await saveRuntimeConfig(config);
    setRuntimeConfig(saved);
    setHealth(await getHealth());
    setSettingsOpen(false);
    setNotice("Agent configuration saved");
    window.setTimeout(() => setNotice(undefined), 2200);
  }

  function receive(item: PromptEvent) {
    if (item.type === "error") {
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
      if (update && typeof update === "object" && "delta" in update && typeof update.delta === "string") {
        setStreamingText((current) => current + update.delta);
      }
      return;
    }
    if (type === "tool_execution_start") {
      const clarification = clarificationFromEvent(event);
      if (clarification && activeId) {
        setLiveClarification({ sessionId: activeId, request: clarification });
        setAnsweredClarificationId(undefined);
      }
      const label = typeof event.toolName === "string" ? event.toolName : "Using tool";
      const id = String(event.toolCallId ?? crypto.randomUUID());
      setTimeline((current) => [...current, { id, kind: "tool", label, active: true }]);
    } else if (type === "tool_execution_end") {
      const id = String(event.toolCallId ?? "");
      setTimeline((current) => current.map((entry) => entry.id === id ? { ...entry, active: false, kind: "result" } : entry));
    }
  }

  async function send(text: string, images: PendingImage[]) {
    if (!activeId) return;
    setRunning(true);
    awaitingRun.current = true;
    runIdsBeforePrompt.current = new Set(runs.map((run) => run.id));
    setStreamingText("");
    setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "thought", label: text, detail: images.length ? `${images.length} reference image${images.length > 1 ? "s" : ""}` : undefined }]);
    if (activeRunId) {
      const localMessage: WorkflowEvent = {
        id: `local-user-${crypto.randomUUID()}`,
        kind: "message",
        status: "completed",
        actor: "User",
        label: "You",
        detail: text,
        at: new Date().toISOString(),
      };
      setWorkflow((current) => [...current, localMessage]);
    }
    try {
      await streamPrompt(activeId, text, images.map(({ name, data, mimeType }) => ({ name, data, mimeType })), receive, activeRunId);
      const [nextRuns, nextAssets] = await Promise.all([listRuns(), listAssets()]);
      setRuns(nextRuns);
      setAssets(nextAssets);
      const ownedRun = nextRuns.find((run) => run.sessionId === activeId);
      if (ownedRun) setActiveRunId(ownedRun.id);
    } catch (error) {
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "error", label: "Connection interrupted", detail: error instanceof Error ? error.message : String(error) }]);
    } finally {
      awaitingRun.current = false;
      setRunning(false);
    }
  }

  async function stopAgent() {
    if (!activeId || !agentRunning || stopping) return;
    setStopping(true);
    try {
      const result = await abortSession(activeId);
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
      .map((question) => `${question.header}｜${question.question}\n回答：${answers[question.id]?.trim() || "未指定，请采用合理默认值"}`)
      .join("\n\n");
    setAnsweredClarificationId(visibleClarification.id);
    setLiveClarification(undefined);
    void send(`以下是我对 Brief 澄清问题的回答。请将答案合并进 resolvedScope，保留已明确的信息，然后继续同一个工作流：\n\n${response}`, []);
  }

  return (
    <div className={`app-shell ${panelOpen ? "panel-open" : "panel-collapsed"} ${navigationOpen ? "navigation-open" : ""}`}>
      <Sidebar
        runs={runs}
        activeRunId={activeRunId}
        onCreate={() => void addSession()}
        onSelectRun={(id) => void selectProject(id)}
        onRenameRun={(id, title) => void renameProject(id, title)}
        onDeleteRun={(id) => void deleteProject(id)}
        onSettings={() => void openSettings()}
        creating={creating}
      />
      <section className="workspace">
        <header className="workspace-header">
          <div><button className="navigation-trigger" aria-label="Open project navigation" onClick={() => setNavigationOpen(true)}><Menu size={17} /></button><span className="project-kicker">Project</span><h2>{activeRun?.title ?? active?.title ?? (loading ? "Connecting…" : "Design workspace")}</h2></div>
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
      {panelOpen && <AgentPanel timeline={activeRun?.activity ?? timeline} workflow={activeRun ? workflow : []} streamingText={activeRun ? "" : streamingText} running={agentRunning} stopping={stopping} clarification={visibleClarification} onSend={send} onStop={() => void stopAgent()} onAnswerClarification={answerClarification} />}
      {navigationOpen && <button className="navigation-scrim" aria-label="Close project navigation" onClick={() => setNavigationOpen(false)} />}
      {panelOpen && <button className="agent-scrim" aria-label="Close agent panel" onClick={() => setPanelOpen(false)} />}
      {connectionError && <div className="connection-banner"><span><strong>Server unavailable</strong><small>{connectionError}</small></span><button onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} /> {loading ? "Connecting…" : "Reconnect"}</button></div>}
      {notice && <div className="toast">{notice}</div>}
      {settingsOpen && runtimeConfig && <SettingsModal initial={runtimeConfig} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
    </div>
  );
}
