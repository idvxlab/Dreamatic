import type { ReactNode } from 'react';
import { ChevronDown, FileText, FileCode2, Image, Link, ArrowUpRight, ClipboardList } from 'lucide-react';
import { useI18n } from '../i18n';
import { assetUrl } from '../asset-url';
import type { Asset, ProjectFile, RunView, WorkbenchView, WorkflowEvent } from '../types';
import { RunStatus } from './RunStatus';
import { CompletionSummary } from './CompletionSummary';

function OverviewSection({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return <details className="overview-section" open>
    <summary>{icon}<h2>{title}</h2><ChevronDown className="overview-section-chevron" size={16} /></summary>
    <div className="overview-section-body">{children}</div>
  </details>;
}

export function ProjectOverview({ run, workflow, assets, files, running, pending, onNavigate }: { run?: RunView; workflow: WorkflowEvent[]; assets: Asset[]; files: ProjectFile[]; running: boolean; pending?: string; onNavigate: (view: WorkbenchView, file?: ProjectFile) => void }) {
  const { t } = useI18n();
  const flat = (events: WorkflowEvent[]): WorkflowEvent[] => events.flatMap(event => [event, ...flat(event.children ?? [])]);
  const summary = flat(workflow).filter(event => event.completion).at(-1)?.completion;
  const context = files.filter(file => file.category === 'context');
  const references = files.filter(file => file.category === 'references');
  const images = assets.filter(asset => (asset.role === 'generated' || asset.role === 'edited' || (asset.role === 'other' && asset.path.includes('/artifacts/'))) && /^(png|jpe?g|webp|gif|svg)$/u.test(asset.kind));
  const hasShowcase = Boolean(run?.showcasePath || (run?.presentation?.mode === 'html' && run.stages.build === 'completed'));
  const empty = !running && !context.length && !images.length && !hasShowcase && (!run || run.status === 'draft');
  const status: Record<string, string> = { draft: 'Draft', active: 'Working…', completed: 'Complete', complete: 'Complete', interrupted: 'Interrupted', waiting_for_user: 'Waiting for your answers', waiting_for_images: 'Waiting for image retry' };
  return <section className="project-overview">
    {empty ? <div className="overview-welcome"><svg viewBox="0 0 200 140" width="200" height="140" fill="none" aria-hidden="true"><ellipse cx="100" cy="73" rx="86" ry="48" stroke="currentColor" opacity=".16" transform="rotate(-18 100 73)" /><rect x="55" y="28" width="90" height="86" rx="10" fill="var(--panel)" stroke="currentColor" opacity=".65" /><path d="M72 86l19-24 16 17 12-12 11 19H72z" fill="var(--lime)" /><circle cx="119" cy="48" r="7" fill="var(--accent)" /><path d="M35 33v14m-7-7h14m118 53v14m-7-7h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg><p className="eyebrow">{t('Start with an outcome')}</p><h1>{t('Turn a brief into a')}<br />{t('coherent design system.')}</h1><p>{t('Describe your idea in the conversation. Project context, references and works will appear as they are created.')}</p></div> : <>
      <header className="overview-heading"><p className="eyebrow">{t('Project overview')}</p><h1>{run?.title ?? t('Design workspace')}</h1><span className="overview-status" role="status">{t(running ? 'Working…' : status[run?.status ?? ''] ?? run?.status ?? 'Draft')}</span></header>
      <RunStatus workflow={workflow} running={running} pending={pending} showImages={false} />
      {run?.status === 'interrupted' && <p className="overview-notice">{t('The project was interrupted. Continue from the conversation when ready.')}</p>}
      {(run?.notes.length || context.length > 0) ? <OverviewSection title={t('Design Context')} icon={<FileText size={16} />}>
        <div className="overview-context-grid">{run?.notes.map(note => <button className="overview-note" key={note.id} onClick={() => onNavigate('context', context.find(file => file.path === note.path))} onKeyDown={event => {
          const directions: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: 120, PageUp: -120 };
          const distance = directions[event.key];
          if (distance !== undefined) { event.preventDefault(); event.currentTarget.querySelector('.overview-note-body')?.scrollBy({ top: distance }); }
        }}>
          <strong><span>{t(note.title)}</span><ArrowUpRight size={14} /></strong><span className="overview-note-body">{note.text}</span>
        </button>)}</div>
        {context.length > 0 && <button className="overview-link" onClick={() => onNavigate('context')}>{t('View context files')} · {context.length}<ArrowUpRight size={14} /></button>}
      </OverviewSection> : null}
      {references.length > 0 && <OverviewSection title={t('References')} icon={<Link size={16} />}>
        {references.slice(0, 6).map(file => <button className="overview-link" key={file.id} onClick={() => onNavigate('references', file)}>{file.title}<ArrowUpRight size={14} /></button>)}
        <button className="overview-link" onClick={() => onNavigate('references')}>{t('View all references')} · {references.length}</button>
      </OverviewSection>}
      {(images.length > 0 || hasShowcase) && <OverviewSection title={t('Generated works')} icon={<Image size={16} />}>
        <div className="overview-images">{images.map(asset => <button key={asset.path} onClick={() => onNavigate('assets', files.find(file => `runs/${run?.id}/${file.path}` === asset.path))}>
          <img src={assetUrl(asset.path)} alt={asset.label} loading="lazy" /><span>{asset.label}</span>
        </button>)}{hasShowcase && <button className="overview-showcase-card" onClick={() => onNavigate('preview')} aria-label={t('Showcase Page')}>
          <div className="overview-showcase-cover"><FileCode2 size={36} strokeWidth={1.5} /><small>HTML</small><ArrowUpRight size={16} /></div><span>{t('Showcase Page')}</span>
        </button>}</div>
      </OverviewSection>}
      {(summary || (!running && ['completed', 'complete'].includes(run?.status ?? ''))) && <OverviewSection title={t('Run summary')} icon={<ClipboardList size={16} />}>
        {summary ? <CompletionSummary summary={summary} showHeading={false} /> : <p className="overview-notice">{t('This project is complete. No completion summary was recorded.')}</p>}
      </OverviewSection>}
      {hasShowcase && <button className="overview-link" onClick={() => onNavigate('preview')}>{t('View project')}<ArrowUpRight size={14} /></button>}
    </>}
  </section>;
}
