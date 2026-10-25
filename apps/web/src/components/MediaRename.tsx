import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Pencil, X } from 'lucide-react';
import { renameProjectMedia } from '../api';
import { useI18n } from '../i18n';
import { FileListPreview } from './FileListPreview';
import type { ProjectFile } from '../types';

export function MediaRename({ runId, file, onRenamed }: { runId: string; file: ProjectFile; onRenamed?: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const descriptionId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false);
  const [name, setName] = useState(file.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim()) return;
    lock.current = true; setSaving(true); setError('');
    try { await renameProjectMedia(runId, file.id, name); onRenamed?.(); dialog.current?.close(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not rename media. Please try again.'); }
    finally { lock.current = false; setSaving(false); }
  }
  return <><span className="media-rename" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className="media-rename-trigger" aria-label={`${t('Rename media')}: ${file.title}`} title={t('Rename media')} onClick={() => { setName(file.title); setError(''); dialog.current?.showModal(); input.current?.select(); }}><Pencil size={13} /></button>
  </span>
    {createPortal(<dialog ref={dialog} className="media-rename-dialog" aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={saving} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onCancel={event => { if (lock.current) event.preventDefault(); }}>
      <form onSubmit={event => void save(event)}>
        <header className="media-rename-header"><span className="media-rename-symbol"><Pencil size={18} strokeWidth={1.7} /></span><h2 id={titleId}>{t('Rename media')}</h2><button className="media-rename-close" type="button" aria-label={t('Cancel rename')} disabled={saving} onClick={() => dialog.current?.close()}><X size={18} /></button></header>
        <div className="media-rename-body">
        <div className="media-rename-source"><FileListPreview file={file} runId={runId} /><div><span>{t('Original filename')}</span><p>{file.originalName ?? file.path?.split('/').at(-1) ?? file.title}</p></div></div>
        <label>{t('Display name')}<input ref={input} autoFocus maxLength={120} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></label>
        <p className="media-rename-description" id={descriptionId}>{t('Only the display name changes. File paths and existing pages stay unchanged.')}</p>
        {error && <p className="media-rename-error" role="alert">{t(error)}</p>}
        </div>
        <footer className="media-rename-actions"><button type="button" disabled={saving} onClick={() => dialog.current?.close()}>{t('Cancel')}</button><button className="primary" type="submit" disabled={saving || !name.trim()}><Check size={15} />{t(saving ? 'Saving…' : 'Save')}</button></footer>
      </form>
    </dialog>, document.body)}
  </>;
}
