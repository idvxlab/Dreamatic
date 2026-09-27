import { Cloud, Grid2X2, Menu, PanelRightClose, PanelRightOpen, RefreshCw, Share2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createSession, getHealth, getRuntimeConfig, listAssets, listRuns, listSessions, saveRuntimeConfig, streamPrompt, type HealthView, type PromptEvent, type RuntimeConfig } from "./api";
import { AgentPanel, type PendingImage } from "./components/AgentPanel";
import { Canvas } from "./components/Canvas";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import type { Asset, RunView, SessionView, TimelineItem } from "./types";

function eventName(event: Record<string, unknown>): string {
  return typeof event.type === "string" ? event.type : "agent_event";
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
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
  const [selectedAsset, setSelectedAsset] = useState<string>();
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [running, setRunning] = useState(false);
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
  const visibleAssets = useMemo(
    () => activeRunId ? assets.filter((asset) => asset.path.startsWith(`runs/${activeRunId}/`)) : assets,
    [activeRunId, assets],
  );

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setConnectionError(undefined);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        const [existing, existingRuns, initialAssets, runtimeHealth] = await Promise.all([listSessions(), listRuns(), listAssets(), getHealth()]);
        const next = existing.length > 0 ? existing : [await createSession()];
        setSessions(next);
        setRuns(existingRuns);
        setActiveRunId((current) => current && existingRuns.some((run) => run.id === current) ? current : existingRuns[0]?.id);
        setActiveId((current) => current && next.some((session) => session.id === current) ? current : next[0]?.id);
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
          const created = nextRuns.find((run) => !runIdsBeforePrompt.current.has(run.id));
          if (created) {
            setActiveRunId(created.id);
            awaitingRun.current = false;
          }
        }
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  async function addSession() {
    setCreating(true);
    try {
      const session = await createSession();
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
      setActiveRunId(undefined);
      setTimeline([]);
      setStreamingText("");
      setConnectionError(undefined);
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreating(false);
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
    try {
      await streamPrompt(activeId, text, images.map(({ name, data, mimeType }) => ({ name, data, mimeType })), receive);
      const [nextRuns, nextAssets] = await Promise.all([listRuns(), listAssets()]);
      setRuns(nextRuns);
      setAssets(nextAssets);
      if (!activeRunId && nextRuns[0]) setActiveRunId(nextRuns[0].id);
    } catch (error) {
      setTimeline((current) => [...current, { id: crypto.randomUUID(), kind: "error", label: "Connection interrupted", detail: error instanceof Error ? error.message : String(error) }]);
    } finally {
      awaitingRun.current = false;
      setRunning(false);
    }
  }

  return (
    <div className={`app-shell ${panelOpen ? "panel-open" : "panel-collapsed"} ${navigationOpen ? "navigation-open" : ""}`}>
      <Sidebar
        sessions={sessions}
        runs={runs}
        activeId={activeId}
        activeRunId={activeRunId}
        onCreate={() => void addSession()}
        onSelect={(id) => { setActiveId(id); setActiveRunId(undefined); setNavigationOpen(false); }}
        onSelectRun={(id) => {
          setActiveRunId(id);
          const linkedSession = runs.find((run) => run.id === id)?.sessionId;
          if (linkedSession && sessions.some((session) => session.id === linkedSession)) setActiveId(linkedSession);
          setNavigationOpen(false);
        }}
        onSettings={() => void openSettings()}
        creating={creating}
      />
      <section className="workspace">
        <header className="workspace-header">
          <div><button className="navigation-trigger" aria-label="Open project navigation" onClick={() => setNavigationOpen(true)}><Menu size={17} /></button><span className="project-kicker">Project</span><h2>{activeRun?.title ?? active?.title ?? (loading ? "Connecting…" : "Design workspace")}</h2></div>
          <div className="header-actions"><span className="saved"><Cloud size={14} /> Saved locally</span><button className={assetsOpen ? "active" : ""} onClick={() => setAssetsOpen((open) => !open)}><Grid2X2 size={15} /> Assets <em>{visibleAssets.length}</em></button><button onClick={() => void shareWorkspace()}><Share2 size={15} /> Share</button><button className="icon-button" title="Hide agent panel" onClick={() => setPanelOpen(false)}><PanelRightClose size={16} /></button></div>
        </header>
        <Canvas assets={visibleAssets} selected={selectedAsset} onSelect={setSelectedAsset} run={activeRun} />
        {!panelOpen && <button className="open-agent" onClick={() => setPanelOpen(true)}><PanelRightOpen size={15} /> Open agent</button>}
        {assetsOpen && (
          <aside className="asset-drawer">
            <header><div><Grid2X2 size={16} /><span><strong>Project assets</strong><small>{visibleAssets.length} files in this project</small></span></div><button title="Close assets" onClick={() => setAssetsOpen(false)}><X size={15} /></button></header>
            <div>{visibleAssets.length === 0 ? <p>No generated assets yet. Start a design run to create them.</p> : visibleAssets.map((asset) => <button key={asset.path} onClick={() => { setSelectedAsset(asset.path); setAssetsOpen(false); }}><span>{asset.path.split("/").at(-1)}</span><small>{asset.kind.toUpperCase()} · {Math.max(1, Math.round(asset.size / 1024))} KB</small></button>)}</div>
          </aside>
        )}
      </section>
      {panelOpen && <AgentPanel timeline={activeRun?.activity ?? timeline} streamingText={activeRun ? "" : streamingText} running={running} references={visibleAssets.filter((asset) => asset.role === "reference")} onSend={send} />}
      {navigationOpen && <button className="navigation-scrim" aria-label="Close project navigation" onClick={() => setNavigationOpen(false)} />}
      {panelOpen && <button className="agent-scrim" aria-label="Close agent panel" onClick={() => setPanelOpen(false)} />}
      {connectionError && <div className="connection-banner"><span><strong>Server unavailable</strong><small>{connectionError}</small></span><button onClick={() => void loadWorkspace()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={14} /> {loading ? "Connecting…" : "Reconnect"}</button></div>}
      {notice && <div className="toast">{notice}</div>}
      {settingsOpen && runtimeConfig && <SettingsModal initial={runtimeConfig} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
    </div>
  );
}
