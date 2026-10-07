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
  const batch = batches.at(-1)?.imageProgress;
  const items = Object.values(batch?.items ?? {});
  const success = items.filter(item => item.ok).length;
  const failed = items.filter(item => !item.ok).length;
  const images = [...new Set(batches.flatMap(event => Object.values(event.imageProgress!.items).flatMap(item => item.ok && item.path ? [item.path] : [])))];
  const stamp = current?.updatedAt ?? current?.at;
  const age = stamp ? Math.max(0, Math.floor((now - Date.parse(stamp)) / 1000)) : undefined;
  const elapsed = current?.at ? Math.max(0, Math.floor((now - Date.parse(current.at)) / 1000)) : undefined;
  const milestone = flat.filter(event => event.kind === 'milestone' && event.status === 'completed').at(-1);
  if (!running && !images.length) return null;
  return <section className="run-status" aria-label={t('Run status')}>
    {running && <><div className="run-status-heading"><LoaderCircle size={14} className="spin" /><strong>{current ? `${current.actor} · ${t(current.label)}` : t(pending ?? 'Working…')}</strong></div>
      <p className="run-status-detail" role="status" aria-live="polite">{current?.output || current?.detail || t(pending ?? 'Waiting for an execution update…')}</p>
      <small>{Number.isFinite(elapsed) && <span>{t('Current step')}: {elapsed}s</span>}{Number.isFinite(age) && <span>{t('Last status update')}: {age}s {t('ago')}</span>}</small>
      {milestone && <p className="run-status-milestone">{t('Latest milestone')}: {t(milestone.label)}</p>}
    </>}
    {batch && <div className="run-status-counts" role="status">{t('Saved')}: {success} · {t('Failed')}: {failed} · {t('Pending')}: {Math.max(0, batch.total - items.length)} · {t('Total')}: {batch.total}</div>}
    {images.length > 0 && <div className="run-status-images"><small>{t('Saved design images')}</small><div>{images.map(path => <a key={path} href={assetUrl(path)} target="_blank" rel="noreferrer"><img src={assetUrl(path)} alt={path.split('/').at(-1)} /><span>{path.split('/').at(-1)}</span></a>)}</div></div>}
  </section>;
}
