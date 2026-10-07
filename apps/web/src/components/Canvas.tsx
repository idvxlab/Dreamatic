import { Download, ExternalLink, FileImage, Hand, LayoutDashboard, LayoutGrid, Minus, MousePointer2, Plus, Scan, Upload, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { downloadProject, getCanvasState, getHtmlPreview, saveCanvasState } from "../api";
import { PublishDialog } from "./PublishDialog";
import { assetUrl } from "../asset-url";
import type { Asset, CanvasElementState, CanvasState, RunView } from "../types";

interface CanvasProps {
  assets: Asset[];
  selected?: string;
  onSelect: (path: string) => void;
  run?: RunView;
}

type Camera = CanvasState["camera"];
type Gesture =
  | { kind: "pan"; pointerId: number; startX: number; startY: number; camera: Camera }
  | { kind: "element"; pointerId: number; startX: number; startY: number; id: string; x: number; y: number };

const DEFAULT_CAMERA: Camera = { x: 72, y: 72, zoom: .78 };
const LAYOUT_MARKER = "canvas-overview-v3";
const BOARD_X = 40;
const BOARD_WIDTH = 1098;
const CARD_GAP = 24;
const CARD_WIDTH = 350;

function overviewText(run: RunView, visualCount: number) {
  return `${run.title}\n\n${visualCount} visual assets  ·  ${run.notes.length} design notes  ·  ${run.showcasePath ? "preview available" : "preview pending"}`;
}

function autoLayout(assets: Asset[], run?: RunView): CanvasElementState[] {
  const visual = assets
    .filter((asset) => /^(png|jpg|jpeg|webp|gif|svg)$/.test(asset.kind))
    .sort((left, right) => left.path.localeCompare(right.path, undefined, { numeric: true }));
  const candidates: Array<{ role: Asset["role"]; title: string; items: Asset[] }> = [
    { role: "reference", title: "Reference library", items: visual.filter((asset) => asset.role === "reference") },
    { role: "generated", title: "Design development", items: visual.filter((asset) => asset.role === "generated") },
    { role: "edited", title: "Selected and refined", items: visual.filter((asset) => asset.role === "edited") },
    { role: "other", title: "Project assets", items: visual.filter((asset) => !["reference", "generated", "edited"].includes(asset.role)) },
  ];
  const groups = candidates.filter((group) => group.items.length > 0);
  const elements: CanvasElementState[] = [];
  let y = 40;
  if (run) {
    elements.push({ id: "group-overview", kind: "group", x: BOARD_X, y, width: BOARD_WIDTH, height: 42, text: "Project overview", role: "overview" });
    y += 62;
    elements.push({
      id: LAYOUT_MARKER,
      kind: "text",
      role: "overview",
      x: BOARD_X,
      y,
      width: BOARD_WIDTH,
      height: 172,
      text: overviewText(run, visual.length),
    });
    y += 212;
  }
  if (run?.notes.length) {
    elements.push({ id: "group-rationale", kind: "group", x: BOARD_X, y, width: BOARD_WIDTH, height: 42, text: "Design record", role: "rationale" });
    y += 62;
    run.notes.forEach((note, index) => {
      elements.push({
        id: `note-${note.id}`,
        kind: "text",
        role: note.id,
        x: BOARD_X + (index % 3) * (CARD_WIDTH + CARD_GAP),
        y: y + Math.floor(index / 3) * 324,
        width: CARD_WIDTH,
        height: 284,
        text: `${note.title}\n\n${note.text}`,
      });
    });
    y += Math.ceil(run.notes.length / 3) * 324 + 38;
  }
  for (const group of groups) {
    elements.push({ id: `group-${group.role}`, kind: "group", x: BOARD_X, y, width: BOARD_WIDTH, height: 42, text: group.title, role: group.role });
    y += 62;
    group.items.forEach((asset, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      elements.push({
        id: `asset-${asset.path}`,
        kind: "image",
        assetPath: asset.path,
        role: asset.role,
        x: BOARD_X + column * (CARD_WIDTH + CARD_GAP),
        y: y + row * 320,
        width: CARD_WIDTH,
        height: 280,
      });
    });
    y += Math.ceil(group.items.length / 3) * 320 + 54;
  }
  if (run?.htmlEntries?.length) {
    const pages = assets.filter((asset) => asset.kind === "html" && run.htmlEntries?.some((entry) => asset.path === `runs/${run.id}/${entry}`));
    if (pages.length) {
      elements.push({ id: "group-interfaces", kind: "group", x: BOARD_X, y, width: BOARD_WIDTH, height: 42, text: "Interactive pages", role: "interface" });
      y += 62;
      pages.forEach((asset, index) => elements.push({ id: `asset-${asset.path}`, kind: "html", assetPath: asset.path, role: "interface", x: BOARD_X + (index % 3) * (CARD_WIDTH + CARD_GAP), y: y + Math.floor(index / 3) * 180, width: CARD_WIDTH, height: 140, text: asset.label }));
    }
  }
  return elements;
}

function bounds(elements: CanvasElementState[]) {
  if (!elements.length) return { x: 0, y: 0, width: 1000, height: 700 };
  const left = Math.min(...elements.map((item) => item.x));
  const top = Math.min(...elements.map((item) => item.y));
  const right = Math.max(...elements.map((item) => item.x + item.width));
  const bottom = Math.max(...elements.map((item) => item.y + item.height));
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

export function Canvas({ assets, selected, onSelect, run }: CanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const loadedRun = useRef<string | undefined>(undefined);
  const [mode, setMode] = useState<"canvas" | "showcase">("canvas");
  const [tool, setTool] = useState<"select" | "hand">("select");
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [elements, setElements] = useState<CanvasElementState[]>([]);
  const [saving, setSaving] = useState(false);
  const previewRequest = useRef(0);
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewError, setPreviewError] = useState<string>();
  const [previewMode, setPreviewMode] = useState(false);
  const [previewPages, setPreviewPages] = useState<Array<{ path: string; url: string }>>([]);
  const [publishOpen, setPublishOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string>();
  useEffect(() => {
    // Invalidate in-flight requests when switching projects or rebuilding.
    previewRequest.current++;
    setPublishOpen(false);
    setPreviewUrl(undefined);
    setPreviewError(undefined);
    setPreviewPages([]);
    setPreviewMode(false);
    setExportError(undefined);
    setMode("canvas");
  }, [run?.id, run?.presentation?.entry, run?.presentation?.mode, run?.stages.build]);
  useEffect(() => () => { previewRequest.current++; }, []);
  const visualAssets = useMemo(() => assets.filter((asset) => /^(png|jpg|jpeg|webp|gif|svg)$/.test(asset.kind)), [assets]);

  useEffect(() => {
    let cancelled = false;
    loadedRun.current = undefined;
    if (!run) {
      setElements([]);
      setCamera(DEFAULT_CAMERA);
      return;
    }
    void getCanvasState(run.id).then((saved) => {
      if (cancelled) return;
      const savedIsCurrent = saved?.elements.some((item) => item.id === LAYOUT_MARKER);
      setElements(savedIsCurrent ? saved!.elements : autoLayout(assets, run));
      setCamera(saved?.camera ?? DEFAULT_CAMERA);
      loadedRun.current = run.id;
    }).catch(() => {
      if (cancelled) return;
      setElements(autoLayout(assets, run));
      setCamera(DEFAULT_CAMERA);
      loadedRun.current = run.id;
    });
    return () => { cancelled = true; };
  }, [run?.id]);

  useEffect(() => {
    if (!run || loadedRun.current !== run.id) return;
    const next = autoLayout(assets, run);
    const currentIds = new Set(elements.map((item) => item.id));
    const nextIds = new Set(next.map((item) => item.id));
    const membershipChanged = currentIds.size !== nextIds.size || [...nextIds].some((id) => !currentIds.has(id));
    if (membershipChanged) {
      setElements(next);
      return;
    }
    const nextById = new Map(next.map((item) => [item.id, item]));
    const contentChanged = elements.some((item) => item.text !== nextById.get(item.id)?.text);
    if (contentChanged) {
      setElements((current) => current.map((item) => ({ ...item, text: nextById.get(item.id)?.text ?? item.text })));
    }
  }, [assets, elements, run]);

  useEffect(() => {
    if (!run || loadedRun.current !== run.id) return;
    setSaving(true);
    const timer = window.setTimeout(() => {
      const state: CanvasState = { version: 1, runId: run.id, updatedAt: new Date().toISOString(), camera, elements };
      void saveCanvasState(run.id, state).catch(() => undefined).finally(() => setSaving(false));
    }, 650);
    return () => { window.clearTimeout(timer); };
  }, [camera, elements, run?.id]);

  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const box = bounds(elements);
    const padding = 84;
    const zoom = Math.max(.2, Math.min(1.25, Math.min((viewport.clientWidth - padding * 2) / box.width, (viewport.clientHeight - padding * 2) / box.height)));
    setCamera({ zoom, x: (viewport.clientWidth - box.width * zoom) / 2 - box.x * zoom, y: (viewport.clientHeight - box.height * zoom) / 2 - box.y * zoom });
  }, [elements]);

  function reflow() {
    if (!run) return;
    setElements(autoLayout(assets, run));
    setCamera(DEFAULT_CAMERA);
  }

  const zoomAt = useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setCamera((current) => {
      const zoom = Math.max(.2, Math.min(2.4, nextZoom));
      const worldX = (anchorX - current.x) / current.zoom;
      const worldY = (anchorY - current.y) / current.zoom;
      return { zoom, x: anchorX - worldX * zoom, y: anchorY - worldY * zoom };
    });
  }, []);

  function beginPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (tool !== "hand" && event.target !== event.currentTarget)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind: "pan", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, camera };
  }

  function beginElement(event: React.PointerEvent<HTMLElement>, item: CanvasElementState) {
    if (event.button !== 0 || tool === "hand") return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { kind: "element", pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, id: item.id, x: item.x, y: item.y };
    if (item.assetPath) onSelect(item.assetPath);
  }

  function move(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.kind === "pan") {
      setCamera({ ...active.camera, x: active.camera.x + event.clientX - active.startX, y: active.camera.y + event.clientY - active.startY });
    } else {
      const dx = (event.clientX - active.startX) / camera.zoom;
      const dy = (event.clientY - active.startY) / camera.zoom;
      setElements((current) => current.map((item) => item.id === active.id ? { ...item, x: active.x + dx, y: active.y + dy } : item));
    }
  }

  function endGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (gesture.current?.pointerId === event.pointerId) gesture.current = undefined;
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest(".canvas-note")) return;
    event.preventDefault();
    zoomAt(camera.zoom * Math.exp(-event.deltaY * .0012), event.clientX, event.clientY);
  }

  async function openHtml(path?: string) {
    if (!run || run.stages.build !== "completed") return;
    const entry = path?.startsWith(`runs/${run.id}/`) ? path.slice(`runs/${run.id}/`.length) : path;
    const request = ++previewRequest.current;
    setExportError(undefined);
    setPreviewMode(true); setMode("showcase"); setPreviewUrl(undefined); setPreviewError(undefined); setPreviewPages([]);
    try {
      const preview = await getHtmlPreview(run.id, entry);
      if (request !== previewRequest.current) return;
      setPreviewUrl(preview.url); setPreviewPages(preview.entries);
    } catch (error) {
      if (request === previewRequest.current) setPreviewError(error instanceof Error ? error.message : String(error));
    }
  }
  async function exportProject() {
    if (!run || exporting) return;
    setExporting(true); setExportError(undefined);
    const runId = run.id;
    const request = previewRequest.current;
    try { await downloadProject(runId); }
    catch (error) { if (request === previewRequest.current) setExportError(error instanceof Error ? error.message : String(error)); }
    finally { setExporting(false); }
  }
  function openShowcase() {
    setExportError(undefined);
    if (run?.presentation?.mode === "html") { void openHtml(run.presentation.entry); return; }
    previewRequest.current++;
    setPreviewMode(false);
    setMode("showcase");
  }
  const showcaseAvailable = run?.presentation?.mode === "html" ? run.stages.build === "completed" : Boolean(run?.showcasePath);

  const interactive = run?.presentation?.mode === "html" || previewMode;
  const showcaseUrl = interactive ? previewUrl : run?.showcasePath ? assetUrl(run.showcasePath) : undefined;

  return (
    <main className="canvas-shell">
      <div className="canvas-view-switch" role="tablist" aria-label="Project view">
        <button className={mode === "canvas" ? "active" : ""} onClick={() => setMode("canvas")}><LayoutDashboard size={14} /> Canvas</button>
        <button className={mode === "showcase" ? "active" : ""} disabled={!showcaseAvailable} onClick={openShowcase}><FileImage size={14} /> Preview</button>
      </div>
      {mode === "showcase" && (showcaseUrl || interactive) ? (
        <section className="showcase-view">
          {interactive && previewPages.length > 1 && <div className="preview-pages"><label>Page <select aria-label="Prototype page" value={previewUrl ?? ""} onChange={(event) => setPreviewUrl(event.target.value)}>{previewPages.map((page) => <option key={page.path} value={page.url}>{page.path.split("/").at(-1)}</option>)}</select></label></div>}
          {showcaseUrl ? !interactive ? <iframe title={`${run?.title ?? "DreamaticArt"} preview`} src={showcaseUrl} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" /> : <iframe className="prototype-frame" style={{ width: "100%" }} title={`${run?.title ?? "DreamaticArt"} prototype`} src={showcaseUrl} sandbox="allow-scripts allow-downloads" /> : <div className="prototype-loading"><p role={previewError ? "alert" : "status"}>{previewError ?? "Preparing interactive preview…"}</p>{previewError && <button onClick={() => void openHtml(run?.presentation?.mode === "html" ? run.presentation.entry : undefined)}>Retry preview</button>}</div>}
          {showcaseUrl && <div className="preview-actions"><a href={showcaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a><button disabled={exporting || run?.stages.build !== "completed"} onClick={() => void exportProject()}><Download size={14} /> {exporting ? "Exporting…" : "Export"}</button><button disabled={exporting || run?.stages.build !== "completed"} onClick={() => setPublishOpen(true)}><Upload size={14} /> Publish</button></div>}
          {exportError && <p className="preview-export-error" role="alert">{exportError}</p>}
        </section>
      ) : (
        <div ref={viewportRef} className={`canvas-viewport tool-${tool}`} onPointerDown={beginPan} onPointerMove={move} onPointerUp={endGesture} onPointerCancel={endGesture} onWheel={handleWheel}>
          {elements.length === 0 ? (
            run ? (
              <section className="run-progress">
                <p className="eyebrow">Loading project workspace</p>
                <h1>{run.title}</h1>
                <p className="canvas-loading-copy">Restoring the saved design record and visual outputs…</p>
              </section>
            ) : (
              <section className="empty-canvas">
                <div className="empty-orbit"><div><FileImage size={28} /></div></div>
                <p className="eyebrow">A quiet canvas, ready to work</p>
                <h1>Turn a brief into a<br />coherent design system.</h1>
                <p>Ask the agent to begin. Research, Design Context, review challenges, and built artifacts will appear here as the run develops.</p>
                <span><ZoomIn size={14} /> Visual outputs are inspected before delivery</span>
              </section>
            )
          ) : (
            <div className="canvas-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
              {elements.map((item) => item.kind === "group" ? (
                <section key={item.id} className={`canvas-group-label role-${item.role ?? "other"}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={(event) => beginElement(event, item)}>
                  <span>{item.text}</span><small>{item.role === "reference" ? "Evidence and visual anchors" : "Run outputs"}</small>
                </section>
              ) : item.kind === "image" && item.assetPath ? (
                <figure key={item.id} className={`canvas-artboard role-${item.role ?? "other"} ${selected === item.assetPath ? "selected" : ""}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={(event) => beginElement(event, item)}>
                  <div><img draggable={false} src={assetUrl(item.assetPath)} alt="" /></div>
                  <figcaption><span><strong>{item.assetPath.split("/").at(-1)}</strong><small>{item.role}</small></span><a aria-label="Open asset" href={assetUrl(item.assetPath)} target="_blank" rel="noreferrer" onPointerDown={(event) => event.stopPropagation()}><ExternalLink size={13} /></a></figcaption>
                </figure>
              ) : item.kind === "html" ? (
                <article key={item.id} className="canvas-note canvas-html-page" style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={(event) => beginElement(event, item)}><strong>{item.text}</strong><p>HTML interface</p><button onPointerDown={(event) => event.stopPropagation()} onClick={() => void openHtml(item.assetPath)}>Open prototype <ExternalLink size={13} /></button></article>
              ) : item.kind === "text" && item.id === LAYOUT_MARKER && run ? (
                <section key={item.id} className="canvas-project-overview" style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={(event) => beginElement(event, item)}>
                  <p className="eyebrow">Project workspace</p>
                  <h1>{run.title}</h1>
                  <footer><span>{visualAssets.length} visual assets</span><span>{run.notes.length} design notes</span><span>{run.showcasePath ? "Preview available" : "Preview pending"}</span></footer>
                </section>
              ) : item.kind === "text" ? (
                <article key={item.id} className={`canvas-note role-${item.role ?? "other"}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={(event) => beginElement(event, item)}>{item.text}</article>
              ) : null)}
            </div>
          )}
        </div>
      )}
      {mode === "canvas" && (
        <div className="canvas-toolbar" aria-label="Canvas controls">
          <button className={tool === "select" ? "active" : ""} aria-label="Select and move elements" onClick={() => setTool("select")}><MousePointer2 size={16} /></button>
          <button className={tool === "hand" ? "active" : ""} aria-label="Pan canvas" onClick={() => setTool("hand")}><Hand size={16} /></button>
          <span className="tool-separator" />
          <button aria-label="Zoom out" onClick={() => zoomAt(camera.zoom - .1)}><Minus size={15} /></button>
          <button className="zoom-label" title="Reset to 100%" onClick={() => zoomAt(1)}>{Math.round(camera.zoom * 100)}%</button>
          <button aria-label="Zoom in" onClick={() => zoomAt(camera.zoom + .1)}><Plus size={15} /></button>
          <button aria-label="Fit project" onClick={fit}><Scan size={16} /></button>
          <button aria-label="Reflow project cards" title="Reflow project cards" onClick={reflow}><LayoutGrid size={16} /></button>
          {saving && <span className="canvas-saving">Saving…</span>}
        </div>
      )}
      {publishOpen && run && <PublishDialog key={run.id} runId={run.id} title={run.title} onClose={() => setPublishOpen(false)} />}
    </main>
  );
}
