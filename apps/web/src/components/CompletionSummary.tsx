import type { CompletionSummary as Summary } from '@dreamatic/project-data';
import { useI18n } from '../i18n';
import { assetUrl } from '../asset-url';

export function CompletionSummary({ summary, showHeading = true }: { summary: Summary; showHeading?: boolean }) {
  const { t, language } = useI18n();
  const count = (value: number) => value.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
  const duration = (ms: number) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = seconds % 60;
    return [h ? `${h}${t('hr')}` : '', m ? `${m}${t('min')}` : '', `${s}${t('sec')}`].filter(Boolean).join(' ');
  };
  const images = summary.deliverables.filter(item => item.kind === 'image');
  const pages = summary.deliverables.filter(item => item.kind === 'page');
  const documents = summary.deliverables.filter(item => item.kind === 'document');
  const stages: Record<string, string> = { orchestrator: 'Intent understanding', researcher: 'Research', designer: 'Design', builder: 'Image generation and showcase' };
  return <section className="completion-summary" aria-label={t('Project completion summary')}>
    {showHeading && <strong>{t('Design task completed')}</strong>}
    <p className="completion-products">{t('Deliverables')}: {count(images.length)} {t(images.length === 1 ? 'design image' : 'design images')}, {count(pages.length)} {t(pages.length === 1 ? 'showcase page' : 'showcase pages')}, {count(documents.length)} {t(documents.length === 1 ? 'design document' : 'design documents')}.</p>
    {images.length > 0 && <details className="completion-products-list"><summary>{t('Design images')}</summary><ul>{images.map(item => <li key={item.path}><a href={assetUrl(item.path)} target="_blank" rel="noreferrer">{item.label}</a></li>)}</ul></details>}
    {documents.length > 0 && <p className="completion-documents">{documents.map((item, i) => <span key={item.path}>{i > 0 ? ' · ' : ''}<a href={assetUrl(item.path)} target="_blank" rel="noreferrer">{t(item.label)}</a></span>)}</p>}
    <p>{t('Total elapsed time')}: {duration(summary.elapsedMs)}</p>
    <p>{t('Execution')}: {duration(summary.executionMs)}{summary.pausedMs > 1000 ? ` · ${t('Waiting / paused')}: ${duration(summary.pausedMs)}` : ''}</p>
    <table aria-label={t('Stage time and tokens')}>
      <thead><tr><th>{t('Stage')}</th><th>{t('Time')}</th><th>Token</th></tr></thead>
      <tbody>{summary.stages.map(stage => <tr key={stage.stage}><td>{t(stages[stage.stage] || stage.stage)}{stage.attempts === 0 && stage.tokens === 0 && stage.unreportedCalls === 0 ? ` · ${t('Reused')}` : ''}</td><td>{duration(stage.durationMs)}</td><td>{count(stage.tokens)}{stage.unreportedCalls > 0 ? '+' : ''}</td></tr>)}</tbody>
      <tfoot><tr><th>{t('Total')}</th><td>{duration(summary.executionMs)}</td><td>{count(summary.tokens)}{summary.unreportedCalls > 0 ? '+' : ''}</td></tr></tfoot>
    </table>
    <small className="completion-note">{t('Stage time includes tools and retries. Tokens include reported cache and reasoning usage.')}</small>
    {summary.timingIncomplete && <small className="completion-note">{t('Some timing records are incomplete; only observed execution time is counted.')}</small>}
    {summary.unreportedImageCalls > 0 && <small className="completion-note">{t('Image token usage was not reported by the provider.')}</small>}
    {summary.unreportedCalls > 0 && <small className="completion-note">{t('+ indicates reported tokens only; unreported usage is excluded.')}</small>}
  </section>;
}
