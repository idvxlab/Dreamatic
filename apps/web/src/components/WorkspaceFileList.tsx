import { ExternalLink, Plus, RefreshCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { CANVAS_MEDIA_MIME, mediaKind } from '../canvas-media';
import { FileListPreview } from './FileListPreview';
import type { ProjectFile } from '../types';
export function WorkspaceFileList({ runId, files, selected, title, loading, error, onSelect, onRetry, canvasMode = false, onAdd }: { runId?: string; files: ProjectFile[]; selected?: string; title: string; loading: boolean; error?: string; onSelect: (file: ProjectFile) => void; onRetry: () => void; canvasMode?: boolean; onAdd?: (file: ProjectFile) => void }) {
  const { t } = useI18n();
  const groups = [...new Set(files.map(file => file.group))];
  return <section className="workspace-files"><header className="agent-header"><strong>{t(title)}</strong><button className="file-refresh" onClick={onRetry} aria-label={t('Refresh files')}><RefreshCw size={14} /></button></header><div className="workspace-file-scroll">
    {canvasMode && <p className="canvas-media-hint">{t("Drag images and videos onto the canvas, or use Add to canvas.")}</p>}
    {loading && <p role="status">{t('Loading files…')}</p>}
    {error && <p role="alert">{t('Could not load project files')}<small>{error}</small><button onClick={onRetry}>{t('Retry')}</button></p>}
    {!loading && !error && !files.length && <p>{t('No files in this section yet')}</p>}
    {groups.map(group => <section className="workspace-file-group" key={group}><h3>{t(group)}</h3>{files.filter(file => file.group === group).map(file => {
      const draggable = Boolean(canvasMode && runId && mediaKind(file));
      return <div className="workspace-file-row" key={file.id}><button className={`workspace-file-item${selected === file.id ? ' selected' : ''}${draggable ? ' draggable-media' : ''}`} draggable={draggable} onDragStart={event => {
        if (!draggable || !runId) { event.preventDefault(); return; }
        event.dataTransfer.setData(CANVAS_MEDIA_MIME, JSON.stringify({ runId, fileId: file.id }));
        event.dataTransfer.effectAllowed = 'copy';
      }} aria-pressed={selected === file.id} onClick={() => onSelect(file)}><FileListPreview file={file} runId={runId} /><span className="workspace-file-label"><strong>{file.title}</strong><small>{file.path ?? file.url ?? file.kind.toUpperCase()}</small></span>{file.url && <ExternalLink size={12} />}</button>{draggable && onAdd && <button className="canvas-media-add" aria-label={`${t('Add to canvas')}: ${file.title}`} title={t('Add to canvas')} onClick={() => onAdd(file)}><Plus size={14} /></button>}</div>;
    })}</section>)}
  </div></section>;
}
