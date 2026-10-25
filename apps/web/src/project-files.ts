import { useEffect, useState } from 'react';
import { listProjectFiles } from './api';
import type { ProjectFile } from './types';

export function useProjectFiles(runId?: string, running = false) {
  const [revision, refresh] = useState(0);
  const [state, setState] = useState<{ runId?: string; files: ProjectFile[]; loading: boolean; error?: string }>({ files: [], loading: false });
  useEffect(() => {
    if (!runId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setState(current => ({ runId, files: current.runId === runId ? current.files : [], loading: true }));
    async function load() {
      try {
        const files = await listProjectFiles(runId!);
        if (!disposed) setState({ runId, files, loading: false });
      } catch (error) {
        if (!disposed) setState(current => ({ ...current, runId, loading: false, error: error instanceof Error ? error.message : String(error) }));
      } finally { if (!disposed) timer = setTimeout(() => void load(), document.hidden ? 60000 : running ? 3000 : 15000); }
    }
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [runId, running, revision]);
  return { ...(state.runId === runId ? state : { files: [], loading: Boolean(runId), error: undefined }), refresh: () => refresh(value => value + 1) };
}
