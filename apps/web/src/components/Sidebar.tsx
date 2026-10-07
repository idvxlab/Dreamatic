import { useI18n } from "../i18n";
import { Archive, Info, Github, Check, ChevronDown, Layers3, MoreHorizontal, Pencil, Plus, Search, Settings2, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { VERSION_REPOSITORY_URL } from "../app-info";
import { AboutModal } from "./AboutModal";
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
  const { t } = useI18n();
  const [brandMenuOpen, setBrandMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const brandArea = useRef<HTMLDivElement>(null);
  const brandButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!brandMenuOpen) return;
    const dismiss = (event: MouseEvent) => { if (!brandArea.current?.contains(event.target as Node)) setBrandMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setBrandMenuOpen(false); brandButton.current?.focus(); } };
    document.addEventListener("mousedown", dismiss); document.addEventListener("keydown", escape);
    brandArea.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => { document.removeEventListener("mousedown", dismiss); document.removeEventListener("keydown", escape); };
  }, [brandMenuOpen]);
  const [query, setQuery] = useState("");
  const [menuRunId, setMenuRunId] = useState<string>();
  const [editingRunId, setEditingRunId] = useState<string>();
  const [draftTitle, setDraftTitle] = useState("");
  const visibleRuns = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return term ? runs.filter((run) => run.title.toLocaleLowerCase().includes(term)) : runs;
  }, [query, runs]);
  const runLabel = (run: RunView) => {
    if (run.status === "draft") return t("Draft");
    if (run.status === "complete") return t("Complete");
    const activeStage = Object.entries(run.stages).find(([, status]) => status === "in_progress")?.[0];
    const stage = activeStage ? activeStage[0]!.toUpperCase() + activeStage.slice(1) : undefined;
    if (run.status === "interrupted") return `${t("Interrupted")}${stage ? ` · ${t(stage)}` : ""}`;
    return stage ? t(stage) : `${run.assetCount} ${t("Project assets")}`;
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
    if (window.confirm(`${t("Delete project?")} “${run.title}”\n\n${t("The project will be moved to local Trash and can be recovered from disk.")}`)) onDeleteRun(run.id);
  };

  return (
    <aside className="sidebar" id="project-panel">
      <div className="brand-area" ref={brandArea}>
        <button ref={brandButton} className="brand-row" aria-label={t("DreamaticArt menu")} aria-haspopup="menu" aria-expanded={brandMenuOpen} aria-controls={brandMenuOpen ? "brand-menu" : undefined} onClick={() => setBrandMenuOpen(open => !open)}>
          <div className="brand-mark"><Sparkles size={17} strokeWidth={1.8} /></div>
          <div><strong>DreamaticArt</strong><span>{t("Design intelligence")}</span></div>
          <ChevronDown className="muted-icon" size={15} />
        </button>
        {brandMenuOpen && <div className="brand-menu" id="brand-menu" role="menu" aria-label={t("DreamaticArt menu")} onKeyDown={event => {
          const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) { event.preventDefault(); const index = items.indexOf(document.activeElement as HTMLElement); const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length; items[next]?.focus(); }
        }}>
          <a role="menuitem" href={VERSION_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" onClick={() => setBrandMenuOpen(false)}><Github size={16} /> GitHub</a>
          <button role="menuitem" onClick={() => { setBrandMenuOpen(false); onSettings(); }}><Settings2 size={16} /> {t("Settings")}</button>
          <button role="menuitem" onClick={() => { setBrandMenuOpen(false); setAboutOpen(true); }}><Info size={16} /> {t("About DreamaticArt")}</button>
        </div>}
      </div>
      <button className="new-project" onClick={onCreate} disabled={creating}><Plus size={16} /> {creating ? t("Creating…") : t("New project")}</button>
      <div className="search-box"><Search size={15} /><input aria-label={t("Search projects")} placeholder={t("Search projects")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <div className="nav-label">{t("Workspace")}</div>
      <button className="nav-item active"><Layers3 size={16} /> {t("All projects")} <span>{runs.length}</span></button>
      <button className="nav-item" disabled title={t("Archiving is not enabled in the local runtime yet")}><Archive size={16} /> {t("Archived")} <small>{t("Soon")}</small></button>
      <div className="nav-label project-label">{t("Recent projects")}</div>
      <div className="project-list">
        {visibleRuns.map((run) => (
          <div key={run.id} className={`project-row ${run.id === activeRunId ? "selected" : ""}`}>
            {editingRunId === run.id ? <form className="project-rename" onSubmit={(event) => { event.preventDefault(); saveRename(); }}>
              <input autoFocus value={draftTitle} maxLength={120} onChange={(event) => setDraftTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setEditingRunId(undefined); }} />
              <button type="submit" aria-label={t("Save project name")} disabled={!draftTitle.trim()}><Check size={13} /></button>
              <button type="button" aria-label={t("Cancel rename")} onClick={() => setEditingRunId(undefined)}><X size={13} /></button>
            </form> : <>
              <button className="project-select" onClick={() => { setMenuRunId(undefined); onSelectRun(run.id); }}>
                <span className="session-thumb">{run.title.slice(0, 1).toUpperCase()}</span>
                <span><strong>{run.title}</strong><small>{runLabel(run)}</small></span>
              </button>
              <button className="project-menu-trigger" aria-label={`${t("Project actions")}: ${run.title}`} onClick={() => setMenuRunId((current) => current === run.id ? undefined : run.id)}><MoreHorizontal size={15} /></button>
              {menuRunId === run.id && <div className="project-menu">
                <button onClick={() => beginRename(run)}><Pencil size={13} /> {t("Rename")}</button>
                <button className="danger" disabled={run.status === "active"} title={run.status === "active" ? t("Wait for the running agent to finish before deleting") : undefined} onClick={() => confirmDelete(run)}><Trash2 size={13} /> {t("Delete")}</button>
              </div>}
            </>}
          </div>
        ))}
        {visibleRuns.length === 0 && <p className="empty-projects">{t("No matching projects")}</p>}
      </div>
      {aboutOpen && <AboutModal onClose={() => { setAboutOpen(false); brandButton.current?.focus(); }} />}
    </aside>
  );
}
