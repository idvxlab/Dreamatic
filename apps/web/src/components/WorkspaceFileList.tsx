import { useEffect, useRef, useState } from 'react';
import { uploadCanvasMedia } from '../api';
import { ExternalLink, RefreshCw, Upload } from 'lucide-react';
import { useI18n } from '../i18n';
import { CANVAS_MEDIA_MIME, mediaKind } from '../canvas-media';
import { MediaRename } from './MediaRename';
import { FileListPreview } from './FileListPreview';
import type { ProjectFile } from '../types';
export function WorkspaceFileList({ runId, files, selected, title, loading, error, onSelect, onRetry, canvasMode = false, onRenamed, onAddResult }: { runId?: string; files: ProjectFile[]; selected?: string; title: string; loading: boolean; error?: string; onSelect: (file: ProjectFile) => void; onRetry: () => void; canvasMode?: boolean; onRenamed?: () => void; onAddResult?: (file: ProjectFile) => void }) {
  const { t } = useI18n();
  const shownFiles = canvasMode ? files.filter(file => mediaKind(file)) : files;
  const groups = [...new Set(shownFiles.map(file => file.group))];
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [uploading, setUploading] = useState(false);
  const uploadLock = useRef(false);
  const [dragOverUpload, setDragOverUpload] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<string>();
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function upload(selected: FileList | null) {
    if (!selected?.length || !runId || uploadLock.current) return;
    const batch = [...selected];
    if (input.current) input.current.value = '';
    const invalid = batch.some(file => !/\.(png|jpe?g|webp|gif|svg|mp4|webm|mov)$/iu.test(file.name));
    if (invalid) { setUploadMessage('Only image and video files can be uploaded to Canvas.'); return; }
    if (batch.some(file => file.size > 100 * 1024 * 1024)) { setUploadMessage('Each media file must be 100 MB or smaller.'); return; }
    uploadLock.current = true;
    setUploading(true); setUploadMessage(undefined);
    try {
      for (const file of batch) await uploadCanvasMedia(runId, file);
    } catch (error) { if (mounted.current) setUploadMessage(error instanceof Error ? error.message : 'Media upload failed. Please try again.'); }
    finally { uploadLock.current = false; if (mounted.current) { setUploading(false); onRetry(); } }
  }
  return <section className="workspace-files"><header className="agent-header"><strong>{t(title)}</strong><button className="file-refresh" onClick={onRetry} aria-label={t('Refresh files')}><RefreshCw size={14} /></button></header>
    {canvasMode && <div className="canvas-upload-area">
      <input ref={input} type="file" hidden multiple accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.mp4,.webm,.mov" aria-label={t('Upload media files')} onChange={event => void upload(event.target.files)} />
      <button type="button" className={`canvas-upload-zone${dragOverUpload ? ' drag-over' : ''}`} aria-label={t('Upload media')} aria-disabled={!runId || uploading} aria-busy={uploading} onClick={() => { if (runId && !uploadLock.current) input.current?.click(); }}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault(); event.stopPropagation();
          event.dataTransfer.dropEffect = runId && !uploadLock.current ? 'copy' : 'none';
          if (runId && !uploadLock.current) setDragOverUpload(true);
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverUpload(false); }}
        onDrop={event => {
          if (!event.dataTransfer.types.includes('Files')) return;
          event.preventDefault(); event.stopPropagation(); setDragOverUpload(false);
          void upload(event.dataTransfer.files);
        }}>
        {uploading ? <RefreshCw size={22} className="spin" /> : <Upload size={22} strokeWidth={1.6} />}
        <strong>{t(uploading ? 'Uploading…' : dragOverUpload ? 'Drop files to upload' : 'Drag images or videos here')}</strong>
        <span>{t('or click to choose files')}</span><small>{t('Images and videos · Up to 100 MB per file')}</small>
      </button>
      {uploadMessage && <p className="canvas-upload-feedback" role="alert">{t(uploadMessage)}</p>}
      {uploading && <span className="canvas-upload-feedback" role="status">{t('Uploading…')}</span>}
    </div>}
    <div className="workspace-file-scroll">
    {canvasMode && <p className="canvas-media-hint">{t("Drag images and videos onto the canvas.")}</p>}
    {loading && <p role="status">{t('Loading files…')}</p>}
    {error && <p role="alert">{t('Could not load project files')}<small>{error}</small><button onClick={onRetry}>{t('Retry')}</button></p>}
    {!loading && !error && !shownFiles.length && <p>{t('No files in this section yet')}</p>}
    {groups.map(group => <section className="workspace-file-group" key={group}><h3>{t(group)}</h3>{shownFiles.filter(file => file.group === group).map(file => {
      const draggable = Boolean(canvasMode && runId && mediaKind(file));
      return <div className="workspace-file-row" key={file.id}><button className={`workspace-file-item${selected === file.id ? ' selected' : ''}${draggable ? ' draggable-media' : ''}`} draggable={draggable} onDragStart={event => {
        if (!draggable || !runId) { event.preventDefault(); return; }
        event.dataTransfer.setData(CANVAS_MEDIA_MIME, JSON.stringify({ runId, fileId: file.id }));
        event.dataTransfer.effectAllowed = 'copy';
      }} aria-pressed={selected === file.id} onClick={() => onSelect(file)}><FileListPreview file={file} runId={runId} /><span className="workspace-file-label"><strong>{file.title}</strong><small>{file.path ?? file.url ?? file.kind.toUpperCase()}</small></span>{file.url && <ExternalLink size={12} />}</button>{draggable && runId && <MediaRename runId={runId} file={file} onRenamed={onRenamed ?? onRetry} onAddResult={onAddResult} />}</div>;
    })}</section>)}
  </div></section>;
}
