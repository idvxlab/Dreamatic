import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, LoaderCircle, Pencil, Plus, Sparkles, X } from 'lucide-react';
import { editProjectImage, getImageEditSettings, projectFileUrl, renameProjectMedia, type ImageEditSettings } from '../api';
import { useI18n } from '../i18n';
import { FileListPreview } from './FileListPreview';
import type { ProjectFile } from '../types';

export function MediaRename({ runId, file, onRenamed, onAddResult }: { runId: string; file: ProjectFile; onRenamed?: () => void; onAddResult?: (file: ProjectFile) => void }) {
  const { t } = useI18n();
  const titleId = useId(), descriptionId = useId(), tabsId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lock = useRef(false), mounted = useRef(true);
  const generation = useRef<AbortController | undefined>(undefined);
  const [name, setName] = useState(file.title);
  const [saving, setSaving] = useState(false), [generating, setGenerating] = useState(false);
  const [error, setError] = useState(''), [mode, setMode] = useState<'name' | 'image'>('name');
  const [prompt, setPrompt] = useState('');
  const [result, setResult] = useState<ProjectFile>();
  const [settings, setSettings] = useState<ImageEditSettings>();
  const [settingsError, setSettingsError] = useState(''), [settingsAttempt, setSettingsAttempt] = useState(0);
  const image = /^(png|jpe?g|webp|gif|svg)$/u.test(file.kind);
  const supported = /^(png|jpe?g|webp)$/u.test(file.kind) && (file.size ?? 0) < 50 * 1024 * 1024;
  const busy = saving || generating;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current?.abort(); }; }, []);
  useEffect(() => {
    if (mode !== 'image' || !supported) return;
    let disposed = false;
    setSettings(undefined); setSettingsError('');
    void getImageEditSettings(runId).then(value => { if (!disposed) setSettings(value); }).catch(error => { if (!disposed) setSettingsError(error instanceof Error ? error.message : 'Could not load image edit settings.'); });
    return () => { disposed = true; };
  }, [mode, runId, supported, settingsAttempt]);
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !name.trim()) return;
    lock.current = true; setSaving(true); setError('');
    try { await renameProjectMedia(runId, file.id, name); onRenamed?.(); dialog.current?.close(); }
    catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not rename media. Please try again.'); }
    finally { lock.current = false; if (mounted.current) setSaving(false); }
  }
  async function generate(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !prompt.trim() || !settings?.enabled || !settings.configured || !supported) return;
    const controller = new AbortController(); generation.current = controller;
    lock.current = true; setGenerating(true); setError(''); setResult(undefined);
    try {
      const edited = await editProjectImage(runId, file.id, prompt, controller.signal);
      if (mounted.current) { setResult(edited); onRenamed?.(); }
    } catch (error) {
      if (mounted.current) setError(controller.signal.aborted ? 'Image editing cancelled.' : error instanceof Error ? error.message : 'Image editing failed. Please try again.');
    } finally {
      lock.current = false; generation.current = undefined;
      if (mounted.current) setGenerating(false);
    }
  }
  const title = image ? 'Edit image' : 'Rename media';
  return <><span className="media-rename" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className="media-rename-trigger" aria-label={`${t(title)}: ${file.title}`} title={t(title)} onClick={() => { setName(file.title); setError(''); setMode('name'); setPrompt(''); setResult(undefined); dialog.current?.showModal(); input.current?.select(); }}><Pencil size={13} /></button>
  </span>
    {createPortal(<dialog ref={dialog} className={`media-rename-dialog${image ? ' image-edit-dialog' : ''}`} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onCancel={event => { if (lock.current) event.preventDefault(); }}>
      <form onSubmit={event => void (mode === 'image' ? generate(event) : save(event))}>
        <header className="media-rename-header"><span className="media-rename-symbol"><Pencil size={18} strokeWidth={1.7} /></span><h2 id={titleId}>{t(title)}</h2><button className="media-rename-close" type="button" aria-label={t('Cancel rename')} disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button></header>
        {image && <div className="image-edit-tabs" role="tablist" aria-label={t('Image editing options')}>{(['name', 'image'] as const).map(value => <button key={value} type="button" id={`${tabsId}-${value}`} role="tab" aria-selected={mode === value} aria-controls={`${tabsId}-panel`} tabIndex={mode === value ? 0 : -1} disabled={busy} onClick={() => { setMode(value); setError(''); }} onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'name' : event.key === 'End' ? 'image' : value === 'name' ? 'image' : 'name'; setMode(next); setError(''); document.getElementById(`${tabsId}-${next}`)?.focus(); } }}>{value === 'image' && <Sparkles size={14} />}{t(value === 'name' ? 'Display name' : 'Edit with prompt')}</button>)}</div>}
        <div className="media-rename-body" id={`${tabsId}-panel`} role={image ? 'tabpanel' : undefined} aria-labelledby={image ? `${tabsId}-${mode}` : undefined}>
          {mode === 'name' ? <>
            <div className="media-rename-source"><FileListPreview file={file} runId={runId} /><div><span>{t('Original filename')}</span><p>{file.originalName ?? file.path?.split('/').at(-1) ?? file.title}</p></div></div>
            <label>{t('Display name')}<input ref={input} autoFocus maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
            <p className="media-rename-description" id={descriptionId}>{t('Only the display name changes. File paths and existing pages stay unchanged.')}</p>
          </> : <>
            <div className={`image-edit-previews${result ? ' has-result' : ''}`}><figure><img src={projectFileUrl(runId, file.id)} alt={file.title} /><figcaption>{t('Source image')}</figcaption></figure>{result && <figure><img src={projectFileUrl(runId, result.id)} alt={t('Edited image')} /><figcaption>{t('Edited image')}</figcaption></figure>}</div>
            <label>{t('Edit prompt')}<textarea aria-label={t('Edit prompt')} autoFocus maxLength={8000} rows={4} value={prompt} disabled={busy || !supported} placeholder={t('Describe what to change and what to keep…')} onChange={event => setPrompt(event.target.value)} /></label>
            <p className="media-rename-description" id={descriptionId}>{t('Your original image is preserved. Each edit is saved as a new asset; existing pages stay unchanged.')}</p>
            {!supported ? <p className="image-edit-config">{t('Image editing supports PNG, JPEG and WebP images smaller than 50 MB. Export other formats to PNG before editing.')}</p>
              : settingsError ? <p className="image-edit-config" role="alert">{t(settingsError)} <button type="button" onClick={() => setSettingsAttempt(value => value + 1)}>{t('Retry')}</button></p>
              : !settings ? <p className="image-edit-config" role="status">{t('Loading image edit settings…')}</p>
              : <p className="image-edit-config">{!settings.enabled ? t('Image editing is disabled in Settings.') : !settings.configured ? t('Configure an image API key in Settings before editing images.') : <>{t('Image edit model')}: <span>{settings.model}</span> · {t('Original dimensions unless resizing is requested')}</>}</p>}
            {generating && <p className="image-edit-progress" role="status"><LoaderCircle size={15} className="spin" />{t('Editing image… This may take a few minutes.')}</p>}
            {result && <div className="image-edit-result" role="status"><Check size={16} /><span>{t('Edited image saved to the asset list.')}</span>{onAddResult && <button type="button" onClick={() => { onAddResult(result); dialog.current?.close(); }}><Plus size={14} />{t('Add result to canvas')}</button>}</div>}
          </>}
          {error && <p className="media-rename-error" role="alert">{t(error)}</p>}
        </div>
        <footer className="media-rename-actions">{generating ? <button type="button" onClick={() => generation.current?.abort()}>{t('Cancel generation')}</button> : <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>{t('Cancel')}</button>}
          {mode === 'name' ? <button className="primary" type="submit" disabled={busy || !name.trim()}><Check size={15} />{t(saving ? 'Saving…' : 'Save')}</button>
            : <button className="primary" type="submit" disabled={busy || !prompt.trim() || !supported || !settings?.enabled || !settings.configured}>{generating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{t(generating ? 'Generating…' : 'Generate edit')}</button>}
        </footer>
      </form>
    </dialog>, document.body)}
  </>;
}
