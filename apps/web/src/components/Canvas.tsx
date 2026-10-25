import { ExternalLink, Grid3X3, Grip, Hand, LayoutGrid, Minus, MousePointer2, Plus, Scan, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { getCanvasState, projectFileUrl } from '../api';
import { MediaRename } from './MediaRename';
import { assetUrl } from '../asset-url';
import { CANVAS_MEDIA_MIME, creativeCanvasElements, draggedMedia, mediaKind } from '../canvas-media';
import { useCanvasSave, waitForCanvasWrites } from '../use-canvas-save';
import type { CanvasElementState, CanvasState, ProjectFile, RunView } from '../types';

interface CanvasProps {
  files: ProjectFile[];
  run?: RunView;
  visible: boolean;
  addRequest?: { fileId: string; nonce: string };
  onSelectFile: (file: ProjectFile) => void;
  onRenamed?: () => void;
  onOpenPreview?: (path: string) => void;
}
type Camera = CanvasState['camera'];
type Gesture =
  | { kind: 'pan'; pointerId: number; startX: number; startY: number; camera: Camera }
  | { kind: 'move'; pointerId: number; startX: number; startY: number; id: string; x: number; y: number }
  | { kind: 'resize'; pointerId: number; startX: number; startY: number; id: string; width: number; height: number };
const DEFAULT_CAMERA: Camera = { x: 72, y: 72, zoom: .78 };
function bounds(elements: CanvasElementState[]) {
  if (!elements.length) return { x: 0, y: 0, width: 1000, height: 700 };
  const x = Math.min(...elements.map(item => item.x)), y = Math.min(...elements.map(item => item.y));
  return { x, y, width: Math.max(1, ...elements.map(item => item.x + item.width - x)), height: Math.max(1, ...elements.map(item => item.y + item.height - y)) };
}

export function Canvas({ files, run, visible, addRequest, onSelectFile, onOpenPreview, onRenamed }: CanvasProps) {
  const { t } = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | undefined>(undefined);
  const handledAdd = useRef<string | undefined>(undefined);
  const measured = useRef(new Set<string>());
  const [tool, setTool] = useState<'select' | 'hand'>('select');
  const [camera, setCamera] = useState<Camera>(DEFAULT_CAMERA);
  const [guides, setGuides] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('dreamatic-canvas-guides') ?? 'null');
      return { dots: typeof saved?.dots === 'boolean' ? saved.dots : true, grid: typeof saved?.grid === 'boolean' ? saved.grid : false };
    } catch { return { dots: true, grid: false }; }
  });
  useEffect(() => { try { localStorage.setItem('dreamatic-canvas-guides', JSON.stringify(guides)); } catch { /* Controls still work without local storage. */ } }, [guides]);
  const guideBackground = useMemo(() => {
    const layers: string[] = [], sizes: string[] = [], positions: string[] = [];
    const dotSpacing = 18 * camera.zoom, gridSpacing = 72 * camera.zoom;
    if (guides.dots) {
      const radius = Math.max(.5, camera.zoom);
      layers.push(`radial-gradient(circle, #b8bcb4 ${radius}px, transparent ${radius}px)`);
      sizes.push(`${dotSpacing}px ${dotSpacing}px`);
      positions.push(`${camera.x - dotSpacing / 2}px ${camera.y - dotSpacing / 2}px`);
    }
    if (guides.grid) {
      const lineWidth = Math.max(.5, .75 * camera.zoom);
      layers.push(`linear-gradient(to right, #d2d6ce ${lineWidth}px, transparent ${lineWidth}px)`, `linear-gradient(to bottom, #d2d6ce ${lineWidth}px, transparent ${lineWidth}px)`);
      sizes.push(`${gridSpacing}px ${gridSpacing}px`, `${gridSpacing}px ${gridSpacing}px`);
      positions.push(`${camera.x - lineWidth / 2}px ${camera.y - lineWidth / 2}px`, `${camera.x - lineWidth / 2}px ${camera.y - lineWidth / 2}px`);
    }
    return { backgroundImage: layers.join(', ') || 'none', backgroundSize: sizes.join(', ') || 'auto', backgroundPosition: positions.join(', ') || '0 0' };
  }, [camera, guides]);
  const [elements, setElements] = useState<CanvasElementState[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    if (!run) return;
    let disposed = false;
    setLoadError(false); setReady(false);
    void waitForCanvasWrites(run.id).then(() => getCanvasState(run.id)).then(saved => {
      if (disposed) return;
      const restored = creativeCanvasElements(saved?.elements ?? []);
      setElements(restored);
      setCamera(restored.length ? saved?.camera ?? DEFAULT_CAMERA : DEFAULT_CAMERA);
      setReady(true);
    }).catch(() => { if (!disposed) setLoadError(true); });
    return () => { disposed = true; };
  }, [run?.id, loadAttempt]);
  // A failed restore must never overwrite a historical board with an empty one.
  const state = useMemo<CanvasState | undefined>(() => ready && run ? { version: 1, runId: run.id, updatedAt: new Date().toISOString(), camera, elements } : undefined, [camera, elements, ready, run?.id]);
  const persistence = useCanvasSave(state, dirty);
  useEffect(() => { if (!visible) { gesture.current = undefined; setDropActive(false); viewport.current?.querySelectorAll('video').forEach(video => video.pause()); } }, [visible]);
  const selected = elements.find(item => item.id === selectedId);
  const mediaFile = (item: CanvasElementState) => files.find(file => file.id === item.fileId || (file.path && item.assetPath === `runs/${run?.id}/${file.path}`));
  function source(item: CanvasElementState) {
    return item.fileId && run ? projectFileUrl(run.id, item.fileId) : item.assetPath ? assetUrl(item.assetPath) : undefined;
  }
  function choose(item: CanvasElementState) {
    setSelectedId(item.id);
    const file = mediaFile(item); if (file) onSelectFile(file);
  }
  function add(file: ProjectFile, clientX?: number, clientY?: number) {
    const kind = mediaKind(file), rect = viewport.current?.getBoundingClientRect();
    if (!ready || !run || !kind || !rect) return;
    const x = ((clientX ?? rect.left + rect.width / 2) - rect.left - camera.x) / camera.zoom;
    const y = ((clientY ?? rect.top + rect.height / 2) - rect.top - camera.y) / camera.zoom;
    const item: CanvasElementState = {
      id: crypto.randomUUID(), kind, fileId: file.id,
      ...(file.path ? { assetPath: `runs/${run.id}/${file.path}` } : {}),
      text: file.title, role: file.group, x, y, width: 360, height: 280,
    };
    measured.current.add(item.id);
    setElements(current => [...current, item]); setDirty(true); setTool('select'); choose(item);
    setNotice(undefined); viewport.current?.focus();
  }
  useEffect(() => {
    if (!addRequest || !ready || !visible || handledAdd.current === addRequest.nonce) return;
    handledAdd.current = addRequest.nonce;
    const file = files.find(file => file.id === addRequest.fileId && file.category === 'assets');
    if (file) add(file);
  }, [addRequest, ready, visible, files]);
  function drop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault(); setDropActive(false);
    const file = run ? draggedMedia(event.dataTransfer.getData(CANVAS_MEDIA_MIME), run.id, files) : undefined;
    if (!file || !ready) { setNotice('Only images and videos from this project can be added to the canvas.'); return; }
    add(file, event.clientX, event.clientY);
  }
  function beginPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.target instanceof Element && event.target.closest('button, a, input, video')) return;
    if (event.button !== 0 || (tool !== 'hand' && event.target !== event.currentTarget && !(event.target instanceof Element && event.target.closest('.canvas-empty-state')))) return;
    event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    if (tool !== 'hand') setSelectedId(undefined);
    gesture.current = { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, camera };
  }
  function beginElement(event: React.PointerEvent<HTMLElement>, item: CanvasElementState, resize = false) {
    if (event.button !== 0 || !ready) return;
    choose(item); viewport.current?.focus();
    if (tool === 'hand' && !resize) return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = resize ? { kind: 'resize', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, id: item.id, width: item.width, height: item.height }
      : { kind: 'move', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, id: item.id, x: item.x, y: item.y };
  }
  function move(event: React.PointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = (event.clientX - active.startX) / camera.zoom, dy = (event.clientY - active.startY) / camera.zoom;
    if (active.kind === 'pan') setCamera({ ...active.camera, x: active.camera.x + event.clientX - active.startX, y: active.camera.y + event.clientY - active.startY });
    else if (active.kind === 'move') setElements(current => current.map(item => item.id === active.id ? { ...item, x: active.x + dx, y: active.y + dy } : item));
    else {
      measured.current.delete(active.id);
      const scale = Math.max(120 / active.width, 100 / active.height, Math.min(2400 / active.width, 2400 / active.height, 1 + (dx * active.width + dy * active.height) / (active.width ** 2 + active.height ** 2)));
      setElements(current => current.map(item => item.id === active.id ? { ...item, width: active.width * scale, height: active.height * scale } : item));
    }
    setDirty(true);
  }
  function endGesture(event: React.PointerEvent<HTMLElement>) { if (gesture.current?.pointerId === event.pointerId) gesture.current = undefined; }
  function removeSelected() {
    if (!selectedId) return;
    setElements(current => current.filter(item => item.id !== selectedId)); setSelectedId(undefined); setDirty(true);
  }
  function metadata(item: CanvasElementState, width: number, height: number) {
    if (!measured.current.has(item.id) || !width || !height) return;
    measured.current.delete(item.id);
    if (item.width !== 360 || item.height !== 280) return;
    setElements(current => current.map(entry => entry.id === item.id ? { ...entry, height: Math.max(120, Math.min(1200, 342 * height / width + 90)) } : entry));
    setDirty(true);
  }
  const zoomAt = useCallback((nextZoom: number, clientX?: number, clientY?: number) => {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect || !ready) return;
    const anchorX = (clientX ?? rect.left + rect.width / 2) - rect.left, anchorY = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setCamera(current => { const zoom = Math.max(.2, Math.min(2.4, nextZoom)); return { zoom, x: anchorX - (anchorX - current.x) / current.zoom * zoom, y: anchorY - (anchorY - current.y) / current.zoom * zoom }; });
    setDirty(true);
  }, [ready]);
  function fit() {
    const rect = viewport.current?.getBoundingClientRect(); if (!rect || !ready) return;
    const box = bounds(elements), zoom = Math.max(.2, Math.min(1.25, (rect.width - 84) / box.width, (rect.height - 84) / box.height));
    setCamera({ zoom, x: (rect.width - box.width * zoom) / 2 - box.x * zoom, y: (rect.height - box.height * zoom) / 2 - box.y * zoom }); setDirty(true);
  }
  function reflow() {
    if (!ready) return;
    // Arrange existing instances only. Duplicate media and custom elements remain intact.
    const columnWidth = Math.max(360, ...elements.map(item => item.width)) + 24;
    let y = 40;
    const positions = new Map<string, { x: number; y: number }>();
    for (let i = 0; i < elements.length; i += 3) {
      const row = elements.slice(i, i + 3);
      row.forEach((item, col) => positions.set(item.id, { x: 40 + col * columnWidth, y }));
      y += Math.max(...row.map(item => item.height)) + 40;
    }
    setElements(current => current.map(item => ({ ...item, ...positions.get(item.id)! }))); setCamera(DEFAULT_CAMERA); setDirty(true);
  }
  return <main className="canvas-shell">
    <div ref={viewport} tabIndex={0} role="region" aria-label={t('Canvas editing area')} style={guideBackground} className={`canvas-viewport tool-${tool}${dropActive ? ' canvas-drop-active' : ''}`} onPointerDown={beginPan} onPointerMove={move} onPointerUp={endGesture} onPointerCancel={endGesture} onLostPointerCapture={endGesture}
      onWheel={event => { if (event.target instanceof Element && event.target.closest('.canvas-note, video')) return; event.preventDefault(); zoomAt(camera.zoom * Math.exp(-event.deltaY * .0012), event.clientX, event.clientY); }}
      onDragOver={event => { if (!ready || !event.dataTransfer.types.includes(CANVAS_MEDIA_MIME)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropActive(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={drop}
      onKeyDown={event => { if (event.target instanceof Element && event.target.closest('button, a, input, textarea, video, [contenteditable="true"]')) return; if (['Delete', 'Backspace'].includes(event.key) && selectedId) { event.preventDefault(); removeSelected(); } }}>
      {!ready && run ? <section className="run-progress canvas-empty-state"><p className="canvas-loading-copy" role={loadError ? 'alert' : 'status'}>{t(loadError ? 'Could not restore the canvas. Retry before editing.' : 'Restoring canvas…')}</p>{loadError && <button onClick={() => setLoadAttempt(value => value + 1)}>{t('Retry')}</button>}</section> : elements.length > 0 ? <div className="canvas-world" style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}>
        {elements.map(item => item.kind === 'group' ? <section key={item.id} className={`canvas-group-label role-${item.role ?? 'other'}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}><span>{t(item.text ?? '')}</span><small>{t('Run outputs')}</small></section>
          : (item.kind === 'image' || item.kind === 'video') && source(item) ? <figure key={item.id} data-element-id={item.id} className={`canvas-artboard canvas-media ${selectedId === item.id ? 'selected' : ''}`} style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}>
            <div>{item.kind === 'video' ? <video src={source(item)} controls preload="metadata" onPointerDown={event => { event.stopPropagation(); choose(item); }} onLoadedMetadata={event => metadata(item, event.currentTarget.videoWidth, event.currentTarget.videoHeight)} onError={() => setNotice('This media could not be loaded. The original file may be missing or unsupported.')} /> : <img draggable={false} src={source(item)} alt={mediaFile(item)?.title ?? item.text ?? item.assetPath?.split('/').at(-1) ?? ''} onLoad={event => metadata(item, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={() => setNotice('This media could not be loaded. The original file may be missing or unsupported.')} />}</div>
            <figcaption><span><strong>{mediaFile(item)?.title ?? item.text ?? item.assetPath?.split('/').at(-1)}</strong><small>{t(item.kind === 'video' ? 'Video file' : 'Image file')}</small></span>{run && mediaFile(item) && <MediaRename runId={run.id} file={mediaFile(item)!} onRenamed={onRenamed} />}<a aria-label={t('Open asset')} href={source(item)} target="_blank" rel="noreferrer" onPointerDown={event => event.stopPropagation()}><ExternalLink size={13} /></a></figcaption>
            {selectedId === item.id && <button className="canvas-resize-handle" aria-label={t('Resize selected media')} onPointerDown={event => beginElement(event, item, true)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); measured.current.delete(item.id); const factor = ['ArrowLeft', 'ArrowDown'].includes(event.key) ? .9 : 1.1; if (item.width * factor >= 120 && item.height * factor >= 100 && Math.max(item.width, item.height) * factor <= 2400) { setElements(current => current.map(entry => entry.id === item.id ? { ...entry, width: entry.width * factor, height: entry.height * factor } : entry)); setDirty(true); } }} />}
          </figure>
          : item.kind === 'html' ? <article key={item.id} className="canvas-note canvas-html-page" style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}><strong>{item.text}</strong><p>{t('HTML interface')}</p><button onPointerDown={event => event.stopPropagation()} onClick={() => item.assetPath && onOpenPreview?.(item.assetPath)}>{t('Open prototype')} <ExternalLink size={13} /></button></article>
          : item.kind === 'text' ? <article key={item.id} className="canvas-note" style={{ left: item.x, top: item.y, width: item.width, height: item.height }} onPointerDown={event => beginElement(event, item)}>{item.text}</article> : null)}
      </div> : null}
      {dropActive && <div className="canvas-drop-indicator">{t('Drop to add media to the canvas')}</div>}
    </div>
    <div className="canvas-toolbar" aria-label={t('Canvas controls')}>
      <button className={tool === 'select' ? 'active' : ''} aria-label={t('Select and move elements')} onClick={() => setTool('select')}><MousePointer2 size={16} /></button>
      <button className={tool === 'hand' ? 'active' : ''} aria-label={t('Pan canvas')} onClick={() => setTool('hand')}><Hand size={16} /></button><span className="tool-separator" />
      <button disabled={!ready} aria-label={t('Zoom out')} onClick={() => zoomAt(camera.zoom - .1)}><Minus size={15} /></button>
      <button disabled={!ready} className="zoom-label" aria-label={t('Reset to 100%')} title={t('Reset to 100%')} onClick={() => zoomAt(1)}>{Math.round(camera.zoom * 100)}%</button>
      <button disabled={!ready} aria-label={t('Zoom in')} onClick={() => zoomAt(camera.zoom + .1)}><Plus size={15} /></button>
      <button disabled={!ready} aria-label={t('Fit project')} onClick={fit}><Scan size={16} /></button>
      <button disabled={!ready} aria-label={t('Reflow project cards')} title={t('Reflow project cards')} onClick={reflow}><LayoutGrid size={16} /></button>
      <span className="tool-separator" />
      <button className={guides.dots ? 'active' : ''} aria-label={t('Positioning dots')} aria-pressed={guides.dots} title={t(guides.dots ? 'Hide positioning dots' : 'Show positioning dots')} onClick={() => setGuides(current => ({ ...current, dots: !current.dots }))}><Grip size={16} /></button>
      <button className={guides.grid ? 'active' : ''} aria-label={t('Grid lines')} aria-pressed={guides.grid} title={t(guides.grid ? 'Hide grid lines' : 'Show grid lines')} onClick={() => setGuides(current => ({ ...current, grid: !current.grid }))}><Grid3X3 size={16} /></button>
      <button disabled={!selected || !ready} aria-label={t('Remove selected element')} title={t('Remove selected element')} onClick={removeSelected}><Trash2 size={16} /></button>
      {persistence.saving && <span className="canvas-saving">{t('Saving…')}</span>}
    </div>
    {(notice || persistence.error) && <div className="canvas-notice" role="alert">{t(persistence.error ?? notice!)}{persistence.error && <button onClick={persistence.retry}>{t('Retry')}</button>}</div>}
  </main>;
}
