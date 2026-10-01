import { Archive, Check, ChevronDown, Layers3, MoreHorizontal, Pencil, Plus, Search, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { RunView } from "../types";

interface SidebarProps {
  runs: RunView[];
  activeRunId?: string;
  onCreate: () => void;
  onSelectRun: (id: string) => void;
  onRenameRun: (id: string, title: string) => void;
  onDeleteRun: (id: string) => void;
  onSettings: () => void;
  creating?: boolean;
}

export function Sidebar({ runs, activeRunId, onCreate, onSelectRun, onRenameRun, onDeleteRun, onSettings, creating = false }: SidebarProps) {
  const [query, setQuery] = useState("");
  const [menuRunId, setMenuRunId] = useState<string>();
  const [editingRunId, setEditingRunId] = useState<string>();
  const [draftTitle, setDraftTitle] = useState("");
  const visibleRuns = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? runs.filter((run) => run.title.toLocaleLowerCase().includes(term)) : runs;
  }, [query, runs]);
  const runLabel = (run: RunView) => {
    if (run.status === "draft") return "Draft";
    if (run.status === "complete") return "Complete";
    const activeStage = Object.entries(run.stages).find(([, status]) => status === "in_progress")?.[0];
    const stage = activeStage ? activeStage[0]!.toUpperCase() + activeStage.slice(1) : undefined;
    if (run.status === "interrupted") return `Interrupted${stage ? ` · ${stage}` : ""}`;
    return stage ?? `${run.assetCount} project assets`;
  };
  const beginRename = (run: RunView) => {
    setEditingRunId(run.id);
    setDraftTitle(run.title);
    setMenuRunId(undefined);
  };
  const saveRename = () => {
    if (!editingRunId || !draftTitle.trim()) return;
    onRenameRun(editingRunId, draftTitle.trim());
    setEditingRunId(undefined);
  };
  const confirmDelete = (run: RunView) => {
    setMenuRunId(undefined);
    if (window.confirm(`Delete “${run.title}”?\n\nThe project will be moved to Dreamatic's local Trash and can be recovered from disk.`)) onDeleteRun(run.id);
  };

  return (
    <aside className="sidebar" id="project-panel">
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
      <div className="project-list">
        {visibleRuns.map((run) => (
          <div key={run.id} className={`project-row ${run.id === activeRunId ? "selected" : ""}`}>
            {editingRunId === run.id ? <form className="project-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
              <input autoFocus value={draftTitle} maxLength={120} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingRunId(undefined); }} />
              <button type="submit" aria-label="Save project name" disabled={!draftTitle.trim()}><Check size={13} /></button>
              <button type="button" aria-label="Cancel rename" onClick={() => setEditingRunId(undefined)}><X size={13} /></button>
            </form> : <>
              <button className="project-select" onClick={() => { setMenuRunId(undefined); onSelectRun(run.id); }}>
                <span className="session-thumb">{run.title.slice(0, 1).toUpperCase()}</span>
                <span><strong>{run.title}</strong><small>{runLabel(run)}</small></span>
              </button>
              <button className="project-menu-trigger" aria-label={`Project actions for ${run.title}`} onClick={() => setMenuRunId((current) => current === run.id ? undefined : run.id)}><MoreHorizontal size={15} /></button>
              {menuRunId === run.id && <div className="project-menu">
                <button onClick={() => beginRename(run)}><Pencil size={13} /> Rename</button>
                <button className="danger" disabled={run.status === "active"} title={run.status === "active" ? "Wait for the running agent to finish before deleting" : undefined} onClick={() => confirmDelete(run)}><Trash2 size={13} /> Delete</button>
              </div>}
            </>}
          </div>
        ))}
        {visibleRuns.length === 0 && <p className="empty-projects">No matching projects</p>}
      </div>
      <button className="settings-link" onClick={onSettings}><Settings2 size={16} /> Settings</button>
      <div className="profile"><div className="avatar">D</div><span><strong>Designer</strong><small>Local workspace</small></span></div>
    </aside>
  );
}
