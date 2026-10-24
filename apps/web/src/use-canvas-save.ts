import { useCallback, useEffect, useRef, useState } from 'react';
import { saveCanvasState } from './api';
import type { CanvasState } from './types';

// Serialize writes per project, including a final save when a project is unmounted.
const writes = new Map<string, Promise<unknown>>();
function save(state: CanvasState) {
  const previous = writes.get(state.runId) ?? Promise.resolve();
  const operation = previous.catch(() => {}).then(() => saveCanvasState(state.runId, state));
  writes.set(state.runId, operation);
  void operation.finally(() => { if (writes.get(state.runId) === operation) writes.delete(state.runId); }).catch(() => {});
  return operation;
}
export async function waitForCanvasWrites(runId: string) { await writes.get(runId)?.catch(() => {}); }
export function useCanvasSave(state: CanvasState | undefined, dirty: boolean) {
  const latest = useRef<{ state?: CanvasState; dirty: boolean }>({ dirty: false });
  const mounted = useRef(true);
  const lastSaved = useRef<CanvasState | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  latest.current = { state, dirty };
  const persist = useCallback(async (value: CanvasState) => {
    setSaving(true); setError(undefined);
    try { await save(value); lastSaved.current = value; }
    catch { if (mounted.current) setError('Could not save the canvas. Please retry.'); }
    finally { if (mounted.current) setSaving(false); }
  }, []);
  useEffect(() => {
    if (!dirty || !state || state === lastSaved.current) return;
    const timer = setTimeout(() => void persist(state), 650);
    return () => clearTimeout(timer);
  }, [state, dirty, persist]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = latest.current;
      if (current.dirty && current.state && current.state !== lastSaved.current) void save(current.state).catch(() => {});
    };
  }, []);
  return { saving, error, retry: () => { if (latest.current.state) void persist(latest.current.state); } };
}
