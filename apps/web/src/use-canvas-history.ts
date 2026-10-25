import { useRef, useState, type SetStateAction } from 'react';
import type { CanvasEdge } from '@dreamatic/project-data/canvas-graph';
import type { CanvasElementState, CanvasState } from './types';
export interface CanvasSnapshot { elements: CanvasElementState[]; edges: CanvasEdge[]; camera: CanvasState['camera'] }
/** One immutable snapshot per user operation; pointer gestures are grouped explicitly. */
export function useCanvasHistory(initial: CanvasSnapshot) {
  const [snapshot, render] = useState(initial);
  const current = useRef(initial), past = useRef<CanvasSnapshot[]>([]), future = useRef<CanvasSnapshot[]>([]);
  const group = useRef<CanvasSnapshot | undefined>(undefined);
  const [, revision] = useState(0);
  function push(previous: CanvasSnapshot) { past.current = [...past.current.slice(-99), previous]; future.current = []; }
  function replace(next: CanvasSnapshot) { current.current = next; render(next); revision(value => value + 1); }
  function update<K extends keyof CanvasSnapshot>(key: K, value: SetStateAction<CanvasSnapshot[K]>) {
    const previous = current.current;
    const nextValue = typeof value === 'function' ? (value as (old: CanvasSnapshot[K]) => CanvasSnapshot[K])(previous[key]) : value;
    if (JSON.stringify(previous[key]) === JSON.stringify(nextValue)) return;
    if (!group.current) push(previous);
    replace({ ...previous, [key]: nextValue });
  }
  return { ...snapshot, current,
    setElements: (value: SetStateAction<CanvasElementState[]>) => update('elements', value),
    amendElements: (update: (elements: CanvasElementState[]) => CanvasElementState[]) => {
      const amend = (value: CanvasSnapshot): CanvasSnapshot => ({ ...value, elements: update(value.elements) });
      past.current = past.current.map(amend); future.current = future.current.map(amend);
      if (group.current) group.current = amend(group.current);
      replace(amend(current.current));
    },
    setEdges: (value: SetStateAction<CanvasEdge[]>) => update('edges', value),
    setCamera: (value: SetStateAction<CanvasState['camera']>) => update('camera', value),
    begin: () => { if (!group.current) group.current = current.current; },
    end: () => { if (group.current && JSON.stringify(group.current) !== JSON.stringify(current.current)) push(group.current); group.current = undefined; revision(value => value + 1); },
    restore: (value: CanvasSnapshot) => { past.current = []; future.current = []; group.current = undefined; replace(value); },
    undo: () => { const previous = past.current.pop(); if (previous) { future.current.push(current.current); group.current = undefined; replace(previous); } },
    redo: () => { const next = future.current.pop(); if (next) { past.current.push(current.current); group.current = undefined; replace(next); } },
    canUndo: past.current.length > 0, canRedo: future.current.length > 0,
  };
}
