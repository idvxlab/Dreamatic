import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { useI18n } from '../i18n';
import { assetUrl } from '../asset-url';
import type { WorkflowEvent } from '../types';
export function RunStatus({ workflow, running, pending }: { workflow: WorkflowEvent[]; running: boolean; pending?: string }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (!running) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [running]);
  const flat = workflow.flatMap(event => [event, ...(event.children ?? [])]);
  const current = flat.filter(event => event.status === 'running').at(-1);
  const batches = flat.filter(event => event.imageProgress);
  const batchNode = batches.at(-1);
  const batch = batchNode?.imageProgress;
  const generating = Boolean(running && batchNode?.status === 'running');
  const items = Object.values(batch?.items ?? {});
  const success = items.filter(item => item.ok).length;
  const failed = items.filter(item => item.ok === false).length;
  const activeImages = Object.entries(batch?.items ?? {}).filter(([,item]) => item.state === 'generating');
  const queued = items.filter(item => item.state === 'queued').length;
  const reused = items.filter(item => item.ok && item.reused).length;
  const measured = items.filter(item => item.ok && !item.reused && typeof item.durationMs === 'number');
  const average = measured.length ? measured.reduce((sum,item) => sum + item.durationMs!, 0) / measured.length : undefined;
  const duration = (ms: number) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    return seconds >= 60 ? `${Math.floor(seconds / 60)}${t('min')} ${seconds % 60}${t('sec')}` : `${seconds}${t('sec')}`;
  };
  const images = [...new Set(batches.flatMap(event => Object.values(event.imageProgress!.items).flatMap(item => item.ok && item.path ? [item.path] : [])))];
  const stamp = current?.updatedAt ?? current?.at;
  const age = stamp ? Math.max(0, Math.floor((now - Date.parse(stamp)) / 1000)) : undefined;
  const elapsed = current?.at ? Math.max(0, Math.floor((now - Date.parse(current.at)) / 1000)) : undefined;
  const milestone = flat.filter(event => event.kind === 'milestone' && event.status === 'completed').at(-1);
  if (!running && !images.length) return null;
  return <section className="run-status" aria-label={t('Run status')}>
    {running && <><div className="run-status-heading"><LoaderCircle size={14} className="spin" /><strong>{current ? `${current.actor} · ${t(current.label)}` : t(pending ?? 'Working…')}</strong></div>
      <p className="run-status-detail" role="status" aria-live="polite">{generating && items.some(item => item.state) ? t('Creating your design images') : current?.output || current?.detail || t(pending ?? 'Waiting for an execution update…')}</p>
      <small>{Number.isFinite(elapsed) && <span>{t('Current step')}: {elapsed}s</span>}{Number.isFinite(age) && <span>{t('Last status update')}: {age}s {t('ago')}</span>}</small>
      {milestone && <p className="run-status-milestone">{t('Latest milestone')}: {t(milestone.label)}</p>}
    </>}
    {generating && batch && <div className="image-waiting-status">
      <p className="image-waiting-note">{t('Image generation can take several minutes. Keep Dreamatic · Art running until the task finishes.')}</p>
      <div className="image-progress-label"><strong>{t('Images saved')}: {success} / {batch.total}</strong><span>{queued > 0 ? `${t('Queued')}: ${queued}` : t('Finishing image delivery')}</span></div>
      <progress aria-label={t('Image generation progress')} value={success} max={batch.total} />
      {activeImages.length > 0 && <ul className="image-active-list" aria-label={t('Generating now')}>{activeImages.map(([id,item]) => <li key={id}><LoaderCircle size={10} className="spin" /><span>{item.label || id}</span><small>{item.startedAt ? duration(Math.max(0, now - Date.parse(item.startedAt))) : ''}</small></li>)}</ul>}
      <div className="image-timing"><span>{t('Average per new image')}: <strong>{average === undefined ? t('Calculating after the first image') : duration(average)}</strong></span>{reused > 0 && <span>{t('Reused')}: {reused}</span>}{failed > 0 && <span>{t('Failed')}: {failed}</span>}</div>
      {average !== undefined && <small className="image-average-note">{t('Based on saved new images; parallel generation and provider load affect the remaining wait.')}</small>}
    </div>}
    {batch && (!generating || !items.some(item => item.state)) && <div className="run-status-counts" role="status">{t('Saved')}: {success} · {t('Failed')}: {failed} · {t('Pending')}: {Math.max(0, batch.total - success - failed)} · {t('Total')}: {batch.total}</div>}
    {images.length > 0 && <div className="run-status-images"><small>{t('Saved design images')}</small><div>{images.map(path => <a key={path} href={assetUrl(path)} target="_blank" rel="noreferrer"><img src={assetUrl(path)} alt={path.split('/').at(-1)} /><span>{path.split('/').at(-1)}</span></a>)}</div></div>}
  </section>;
}
