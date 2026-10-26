import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Crop, Frame, Info, LoaderCircle, Maximize2, Pencil, Sparkles, X } from 'lucide-react';
import { editProjectImage, planImageEdit, finalizeImageEdit, type EditSizePlan, getImageEditSettings, projectFileUrl, renameProjectMedia, type ImageEditSettings } from '../api';
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
  const [customSize,setCustomSize] = useState(false), [width,setWidth] = useState(''), [height,setHeight] = useState('');
  const [sizePlan,setSizePlan] = useState<EditSizePlan>(), [planError,setPlanError] = useState('');
  const [confirmConflict,setConfirmConflict] = useState(false), [acceptAdaptation,setAcceptAdaptation] = useState(false);
  const [processing,setProcessing] = useState(false);
  const [resultInput, setResultInput] = useState<string>();
  const currentInput = JSON.stringify([prompt, customSize, customSize ? width : '', customSize ? height : '']);
  const [result, setResult] = useState<ProjectFile>();
  const [settings, setSettings] = useState<ImageEditSettings>();
  const [settingsError, setSettingsError] = useState(''), [settingsAttempt, setSettingsAttempt] = useState(0);
  const image = /^(png|jpe?g|webp|gif|svg)$/u.test(file.kind);
  const supported = /^(png|jpe?g|webp)$/u.test(file.kind) && (file.size ?? 0) < 50 * 1024 * 1024;
  const busy = saving || generating || processing;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current?.abort(); }; }, []);
  useEffect(() => {
    if (mode !== 'image' || !supported) return;
    let disposed = false;
    setSettings(undefined); setSettingsError('');
    void getImageEditSettings(runId).then(value => { if (!disposed) setSettings(value); }).catch(error => { if (!disposed) setSettingsError(error instanceof Error ? error.message : 'Could not load image edit settings.'); });
    return () => { disposed = true; };
  }, [mode, runId, supported, settingsAttempt]);
  useEffect(() => {
    if (mode !== 'image' || !supported) return;
    const controller = new AbortController();
    setSizePlan(undefined); setPlanError(''); setConfirmConflict(false); setAcceptAdaptation(false);
    const timer=setTimeout(() => {
      if (customSize && (!Number.isInteger(Number(width)) || !Number.isInteger(Number(height)) || Number(width)<1 || Number(height)<1)) { setPlanError('Enter valid target dimensions.'); return; }
      void planImageEdit(runId,file.id,prompt,customSize?{target:{width:Number(width),height:Number(height)}}:{},controller.signal).then(plan=>{
        if(controller.signal.aborted)return;
        setSizePlan(plan);
        if(!customSize){setWidth(String(plan.sourceDimensions.width));setHeight(String(plan.sourceDimensions.height));}
      }).catch(error=>{if(!controller.signal.aborted)setPlanError(error instanceof Error?error.message:'Could not check image dimensions.');});
    },250);
    return () => {clearTimeout(timer);controller.abort();};
  },[mode,supported,runId,file.id,prompt,customSize,customSize?width:'',customSize?height:'']);
  const canConfirm = !!result && resultInput === currentInput;
  function confirmResult(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !canConfirm || !result || !dialog.current?.open) return;
    lock.current = true;
    onAddResult?.(result);
    dialog.current.close();
  }
  async function processResult(method:'scale'|'crop'|'pad') {
    if(!result?.editId || lock.current || !canConfirm)return;
    lock.current=true;setProcessing(true);setError('');
    try {const processed=await finalizeImageEdit(runId,result.editId,method);if(mounted.current){setResult(processed);onRenamed?.();}}
    catch(error){if(mounted.current)setError(error instanceof Error?error.message:'Image processing failed.');}
    finally{lock.current=false;if(mounted.current)setProcessing(false);}
  }
  const sizeReady=!!sizePlan && (!sizePlan.conflict || confirmConflict) && (!sizePlan.adapted || acceptAdaptation);
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
    if (lock.current || !sizeReady || !prompt.trim() || !settings?.enabled || !settings.configured || !supported) return;
    const controller = new AbortController(); generation.current = controller;
    lock.current = true; setGenerating(true); setError(''); setResult(undefined);
    try {
      const edited = await editProjectImage(runId, file.id, prompt, controller.signal, { ...(customSize?{target:{width:Number(width),height:Number(height)}}:{}), confirmConflict, acceptAdaptation });
      if (mounted.current) { setResult(edited); setResultInput(currentInput); onRenamed?.(); }
    } catch (error) {
      if (mounted.current) setError(controller.signal.aborted ? 'Image editing cancelled.' : error instanceof Error ? error.message : 'Image editing failed. Please try again.');
    } finally {
      lock.current = false; generation.current = undefined;
      if (mounted.current) setGenerating(false);
    }
  }
  const title = image ? 'Edit image' : 'Rename media';
  return <><span className="media-rename" onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <button type="button" className="media-rename-trigger" aria-label={`${t(title)}: ${file.title}`} title={t(title)} onClick={() => { lock.current = false; setResultInput(undefined); setName(file.title); setError(''); setMode('name'); setPrompt(''); setResult(undefined); setCustomSize(false); setSizePlan(undefined); dialog.current?.showModal(); input.current?.select(); }}><Pencil size={13} /></button>
  </span>
    {createPortal(<dialog ref={dialog} className={`media-rename-dialog${image ? ' image-edit-dialog' : ''}`} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={busy} onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onCancel={event => { if (lock.current) event.preventDefault(); }}>
      <form onSubmit={event => void (mode === 'image' ? canConfirm ? confirmResult(event) : generate(event) : save(event))}>
        <header className="media-rename-header"><span className="media-rename-symbol"><Pencil size={18} strokeWidth={1.7} /></span><h2 id={titleId}>{t(title)}</h2><button className="media-rename-close" type="button" aria-label={t('Cancel rename')} disabled={busy} onClick={() => dialog.current?.close()}><X size={18} /></button></header>
        {image && <div className="image-edit-tabs" role="tablist" aria-label={t('Image editing options')}>{(['name', 'image'] as const).map(value => <button key={value} type="button" id={`${tabsId}-${value}`} role="tab" aria-selected={mode === value} aria-controls={`${tabsId}-panel`} tabIndex={mode === value ? 0 : -1} disabled={busy} onClick={() => { setMode(value); setError(''); }} onKeyDown={event => { if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? 'name' : event.key === 'End' ? 'image' : value === 'name' ? 'image' : 'name'; setMode(next); setError(''); document.getElementById(`${tabsId}-${next}`)?.focus(); } }}>{value === 'image' && <Sparkles size={14} />}{t(value === 'name' ? 'Display name' : 'Edit with prompt')}</button>)}</div>}
        <div className="media-rename-body" id={`${tabsId}-panel`} role={image ? 'tabpanel' : undefined} aria-labelledby={image ? `${tabsId}-${mode}` : undefined}>
          {mode === 'name' ? <>
            <div className="media-rename-source"><FileListPreview file={file} runId={runId} /><div><span>{t('Original filename')}</span><p>{file.originalName ?? file.path?.split('/').at(-1) ?? file.title}</p></div></div>
            <label>{t('Display name')}<input ref={input} autoFocus maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
            <p className="media-rename-description" id={descriptionId}>{t('Only the display name changes. File paths and existing pages stay unchanged.')}</p>
          </> : <>
            <div className={`image-edit-previews${result ? ' has-result' : ''}`}><figure><img src={projectFileUrl(runId, file.id)} alt={file.title} /><figcaption>{t('Source image')}</figcaption></figure>{result && <figure><img src={projectFileUrl(runId, result.id)} alt={t('Edited image')} /><figcaption>{t('Edited image')}</figcaption></figure>}</div>
            <label className="image-edit-prompt-field"><span className="image-edit-field-heading">{t('Edit prompt')}<span className="image-edit-counter">{prompt.length} / 8000</span></span><textarea aria-label={t('Edit prompt')} autoFocus maxLength={8000} rows={4} value={prompt} disabled={busy || !supported} placeholder={t('Describe what to change and what to keep…')} onChange={event => setPrompt(event.target.value)} /></label>
            <fieldset className="image-edit-size" disabled={busy}><legend>{t('Output dimensions')}</legend>
              <label className="image-edit-mode-field">{t('Size mode')}<span className="image-edit-select"><select aria-label={t('Size mode')} value={customSize?'custom':'original'} onChange={event=>setCustomSize(event.target.value==='custom')}><option value="original">{t('Keep original dimensions')}</option><option value="custom">{t('Custom dimensions')}</option></select><ChevronDown size={15} aria-hidden="true" /></span></label>
              {customSize && <div className="image-edit-dimensions"><label>{t('Width (px)')}<input aria-label={t('Width (px)')} type="number" min="1" max="16384" value={width} onChange={event=>setWidth(event.target.value)} /></label><label>{t('Height (px)')}<input aria-label={t('Height (px)')} type="number" min="1" max="16384" value={height} onChange={event=>setHeight(event.target.value)} /></label></div>}
              {sizePlan ? <><dl className="image-edit-size-metrics"><div><dt>{t('Original size')}</dt><dd>{sizePlan.sourceDimensions.width} × {sizePlan.sourceDimensions.height}</dd></div><div><dt>{t('Target size')}</dt><dd>{sizePlan.targetDimensions.width} × {sizePlan.targetDimensions.height}</dd></div><div><dt>{t('Generation size')}</dt><dd>{sizePlan.requestSize.replace('x',' × ')}</dd></div></dl><p className="image-edit-size-note"><Info size={13} aria-hidden="true" />{t(sizePlan.capabilitiesKnown?'Configured size constraints':'Size capabilities unverified; actual output may differ.')}</p>
              {sizePlan.conflict && <label className="image-edit-consent"><input type="checkbox" checked={confirmConflict} onChange={event=>setConfirmConflict(event.target.checked)} /><span>{t('The prompt conflicts with the selected size. Use the selected target dimensions.')}</span></label>}
              {sizePlan.adapted && <label className="image-edit-consent"><input type="checkbox" checked={acceptAdaptation} onChange={event=>setAcceptAdaptation(event.target.checked)} /><span>{t('Generate at the supported size shown above; review crop, padding or scaling after generation.')}</span></label>}
              </> : <p role={planError?'alert':'status'}>{t(planError || 'Checking image dimensions…')}</p>}
            </fieldset>
            <p className="media-rename-description" id={descriptionId}>{t('Your original image is preserved. Each edit is saved as a new asset; existing pages stay unchanged.')}</p>
            {!supported ? <p className="image-edit-config">{t('Image editing supports PNG, JPEG and WebP images smaller than 50 MB. Export other formats to PNG before editing.')}</p>
              : settingsError ? <p className="image-edit-config" role="alert">{t(settingsError)} <button type="button" onClick={() => setSettingsAttempt(value => value + 1)}>{t('Retry')}</button></p>
              : !settings ? <p className="image-edit-config" role="status">{t('Loading image edit settings…')}</p>
              : <p className="image-edit-config">{!settings.enabled ? t('Image editing is disabled in Settings.') : !settings.configured ? t('Configure an image API key in Settings before editing images.') : <>{t('Image edit model')}: <span>{settings.model}</span> · {t('Original dimensions unless resizing is requested')}</>}</p>}
            {generating && <p className="image-edit-progress" role="status"><LoaderCircle size={15} className="spin" />{t('Editing image… This may take a few minutes.')}</p>}
            {result?.outputDimensions && <section className="image-edit-output-info"><p>{t('Actual output')}: {result.outputDimensions.width} × {result.outputDimensions.height}{result.targetDimensions && <> · {t('Target size')}: {result.targetDimensions.width} × {result.targetDimensions.height}</>}</p>
              {result.dimensionStatus && result.dimensionStatus !== 'exact' && <><p>{t(result.dimensionStatus==='same-ratio'?'Same aspect ratio; resolution differs.':result.dimensionStatus==='near-ratio'?'Slight aspect ratio difference. Review before processing.':'Aspect ratios differ. Choose crop or padding; no stretching is applied.')}</p><p>{t('The original generated image is saved. You can keep it or save a processed copy.')}</p>
              {result.targetDimensions && (result.targetDimensions.width>result.outputDimensions.width || result.targetDimensions.height>result.outputDimensions.height) && <p>{t('Upscaling increases pixel dimensions, not real image detail.')}</p>}
              <div className="image-edit-processing">{result.dimensionStatus==='same-ratio' && <button type="button" disabled={busy || !canConfirm} onClick={()=>void processResult('scale')}><Maximize2 size={14} />{t('Scale to target')}</button>}<button type="button" disabled={busy || !canConfirm} onClick={()=>void processResult('crop')}><Crop size={14} />{t('Crop to target')}</button><button type="button" disabled={busy || !canConfirm} onClick={()=>void processResult('pad')}><Frame size={14} />{t('Pad to target')}</button></div></>}
            </section>}
            {result && <div className="image-edit-result" role="status"><Check size={16} /><span>{t('Edited image saved to the asset list.')}</span></div>}
          </>}
          {error && <p className="media-rename-error" role="alert">{t(error)}</p>}
        </div>
        <footer className="media-rename-actions">{generating ? <button type="button" onClick={() => generation.current?.abort()}>{t('Cancel generation')}</button> : <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>{t('Cancel')}</button>}
          {mode === 'name' ? <button className="primary" type="submit" disabled={busy || !name.trim()}><Check size={15} />{t(saving ? 'Saving…' : 'Save')}</button>
            : <button className="primary" type="submit" disabled={busy || (!canConfirm && (!sizeReady || !prompt.trim() || !supported || !settings?.enabled || !settings.configured))}>{generating ? <LoaderCircle size={15} className="spin" /> : canConfirm ? <Check size={15} /> : <Sparkles size={15} />}{t(generating ? 'Generating…' : canConfirm ? 'Confirm' : 'Generate edit')}</button>}
        </footer>
      </form>
    </dialog>, document.body)}
  </>;
}
