import { ExternalLink, FileImage, Hand, LayoutDashboard, Minus, MousePointer2, Plus, Scan, ZoomIn } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCanvasState, saveCanvasState } from "../api";
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

function autoLayout(assets: Asset[], run?: RunView): CanvasElementState[] {
  const visual = assets.filter((asset) => /^(png|jpg|jpeg|webp|gif)$/.test(asset.kind));
  const candidates: Array<{ role: Asset["role"]; title: string; items: Asset[] }> = [
    { role: "reference", title: "Reference library", items: visual.filter((asset) => asset.role === "reference") },
    { role: "generated", title: "Design development", items: visual.filter((asset) => asset.role === "generated") },
    { role: "edited", title: "Selected and refined", items: visual.filter((asset) => asset.role === "edited") },
    { role: "other", title: "Project assets", items: visual.filter((asset) => !["reference", "generated", "edited"].includes(asset.role)) },
  ];
  const groups = candidates.filter((group) => group.items.length > 0);
  const elements: CanvasElementState[] = [];
  let y = 40;
  if (run?.notes.length) {
    elements.push({ id: "group-rationale", kind: "group", x: 40, y, width: 980, height: 42, text: "Project thinking", role: "rationale" });
    y += 62;
    run.notes.forEach((note, index) => {
      elements.push({
        id: `note-${note.id}`,
        kind: "text",
        role: note.id,
        x: 40 + (index % 3) * 330,
        y,
        width: 300,
        height: 220,
        text: `${note.title}\n\n${note.text}`,
      });
    });
    y += 274;
  }
  for (const group of groups) {
    elements.push({ id: `group-${group.role}`, kind: "group", x: 40, y, width: 980, height: 42, text: group.title, role: group.role });
    y += 62;
    group.items.forEach((asset, index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      elements.push({
        id: `asset-${asset.path}`,
        kind: "image",
        assetPath: asset.path,
        role: asset.role,
        x: 40 + column * 330,
        y: y + row * 286,
        width: 300,
        height: 244,
      });
    });
    y += Math.ceil(group.items.length / 3) * 286 + 54;
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
  const visualAssets = useMemo(() => assets.filter((asset) => /^(png|jpg|jpeg|webp|gif)$/.test(asset.kind)), [assets]);

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
      setElements(saved?.elements.length ? saved.elements : autoLayout(assets, run));
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
    const known = new Set(elements.filter((item) => item.assetPath).map((item) => item.assetPath));
    const available = new Set(visualAssets.map((asset) => asset.path));
    const missingAssets = visualAssets.filter((asset) => !known.has(asset.path));
    const staleAssets = elements.filter((item) => item.assetPath && !available.has(item.assetPath));
    const knownIds = new Set(elements.map((item) => item.id));
    const missingNotes = run.notes.some((note) => !knownIds.has(`note-${note.id}`));
    if (!missingAssets.length && !staleAssets.length && !missingNotes) return;
    const next = autoLayout(assets, run);
    const persistedByPath = new Map(elements.filter((item) => item.assetPath).map((item) => [item.assetPath, item]));
    setElements(next.map((item) => item.assetPath && persistedByPath.has(item.assetPath) ? persistedByPath.get(item.assetPath)! : item));
  }, [assets, run?.id, run?.notes]);

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

  const showcaseUrl = run?.showcasePath ? assetUrl(run.showcasePath) : undefined;

  return (
    <main className="canvas-shell">
      <div className="canvas-view-switch" role="tablist" aria-label="Project view">
        <button className={mode === "canvas" ? "active" : ""} onClick={() => setMode("canvas")}><LayoutDashboard size={14} /> Canvas</button>
        <button className={mode === "showcase" ? "active" : ""} disabled={!showcaseUrl} onClick={() => setMode("showcase")}><FileImage size={14} /> Showcase</button>
      </div>
      {mode === "showcase" && showcaseUrl ? (
        <section className="showcase-view">
          <iframe title={`${run?.title ?? "Dreamatic"} showcase`} src={showcaseUrl} sandbox="allow-same-origin" />
          <a href={showcaseUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open showcase</a>
        </section>
      ) : (
        <div ref={viewportRef} className={`canvas-viewport tool-${tool}`} onPointerDown={beginPan} onPointerMove={move} onPointerUp={endGesture} onPointerCancel={endGesture} onWheel={(event) => { event.preventDefault(); zoomAt(camera.zoom * Math.exp(-event.deltaY * .0012), event.clientX, event.clientY); }}>
          {elements.length === 0 ? (
            run ? (
              <section className="run-progress">
                <p className="eyebrow">{run.status === "interrupted" ? "Run interrupted — work preserved" : "Design run in progress"}</p>
                <h1>{run.title}</h1>
                <div className="stage-track">{Object.entries(run.stages).map(([name, status]) => <div className={`stage ${status}`} key={name}><span /><strong>{name}</strong><small>{status.replace("_", " ")}</small></div>)}</div>
                <div className="persisted-files"><strong>Persisted work</strong><div>{run.documents.map((path) => <span key={path}>{path}</span>)}</div></div>
              </section>
            ) : (
              <section className="empty-canvas">
                <div className="empty-orbit"><div><FileImage size={28} /></div></div>
                <p className="eyebrow">A quiet canvas, ready to work</p>
                <h1>Turn a brief into a<br />coherent design system.</h1>
                <p>Ask the agent to begin. Research, directions, generated artifacts, and critique will appear here as the run develops.</p>
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
              ) : item.kind === "text" ? (
                <article key={item.id} className="canvas-note" style={{ left: item.x, top: item.y, width: item.width, minHeight: item.height }} onPointerDown={(event) => beginElement(event, item)}>{item.text}</article>
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
          {saving && <span className="canvas-saving">Saving…</span>}
        </div>
      )}
    </main>
  );
}
