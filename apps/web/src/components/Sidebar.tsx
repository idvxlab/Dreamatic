import { Archive, ChevronDown, Layers3, Plus, Search, Settings2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import type { RunView, SessionView } from "../types";

interface SidebarProps {
  sessions: SessionView[];
  runs: RunView[];
  activeId?: string;
  activeRunId?: string;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onSelectRun: (id: string) => void;
  onSettings: () => void;
  creating?: boolean;
}

export function Sidebar({ sessions, runs, activeId, activeRunId, onCreate, onSelect, onSelectRun, onSettings, creating = false }: SidebarProps) {
  const [query, setQuery] = useState("");
  const visibleSessions = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? runs.filter((run) => run.title.toLocaleLowerCase().includes(term)) : runs;
  }, [query, runs]);
  const runLabel = (run: RunView) => {
    if (run.status === "complete") return "Complete";
    const activeStage = Object.entries(run.stages).find(([, status]) => status === "in_progress")?.[0];
    const stage = activeStage ? activeStage[0]!.toUpperCase() + activeStage.slice(1) : undefined;
    if (run.status === "interrupted") return `Interrupted${stage ? ` · ${stage}` : ""}`;
    return stage ?? `${run.assetCount} project assets`;
  };

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><Sparkles size={17} strokeWidth={1.8} /></div>
        <div><strong>Dreamatic</strong><span>Design intelligence</span></div>
        <ChevronDown className="muted-icon" size={15} />
      </div>
      <button className="new-project" onClick={onCreate} disabled={creating}><Plus size={16} /> {creating ? "Creating…" : "New project"}</button>
      <div className="search-box"><Search size={15} /><input aria-label="Search projects" placeholder="Search projects" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="nav-label">Workspace</div>
      <button className="nav-item active"><Layers3 size={16} /> All projects <span>{runs.length}</span></button>
      <button className="nav-item" disabled title="Archiving is not enabled in the local runtime yet"><Archive size={16} /> Archived <small>Soon</small></button>
      <div className="nav-label project-label">Recent projects</div>
      <div className="session-list">
        {visibleSessions.map((run) => (
          <button key={run.id} className={`session-item ${run.id === activeRunId ? "selected" : ""}`} onClick={() => onSelectRun(run.id)}>
            <span className="session-thumb">{run.title.slice(0, 1).toUpperCase()}</span>
            <span><strong>{run.title}</strong><small>{runLabel(run)}</small></span>
          </button>
        ))}
        {visibleSessions.length === 0 && <p className="empty-projects">No matching projects</p>}
      </div>
      <div className="nav-label project-label">Agent sessions</div>
      <div className="session-list">
        {sessions.map((session) => (
          <button key={session.id} className={`session-item ${session.id === activeId && !activeRunId ? "selected" : ""}`} onClick={() => onSelect(session.id)}>
            <span className="session-thumb">{session.title.slice(0, 1).toUpperCase()}</span>
            <span><strong>{session.title}</strong><small>{session.running ? "Agent working" : "Conversation"}</small></span>
          </button>
        ))}
      </div>
      <button className="settings-link" onClick={onSettings}><Settings2 size={16} /> Settings</button>
      <div className="profile"><div className="avatar">D</div><span><strong>Designer</strong><small>Local workspace</small></span></div>
    </aside>
  );
}
