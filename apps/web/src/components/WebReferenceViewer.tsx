import { createElement, useEffect, useId, useState, type ReactNode } from 'react';
import { getReferenceArticle } from '../api';
import { useI18n } from '../i18n';
import type { ProjectFile, ReferenceArticle, ReferenceReaderNode } from '../types';

const tags = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'strong', 'b', 'em', 'i', 'del', 'br', 'hr', 'div', 'span', 'figure', 'figcaption']);
function webUrl(value?: string) {
  if (!value) return;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
function articleNodes(nodes: ReferenceReaderNode[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.tag === 'text') return node.text;
    if (['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form'].includes(node.tag)) return null;
    if (node.tag === 'img') { const src = webUrl(node.src); return src ? <img key={index} src={src} alt={node.alt ?? ''} loading="lazy" referrerPolicy="no-referrer" /> : null; }
    const children = articleNodes(node.children ?? []);
    if (node.tag === 'a') { const href = webUrl(node.href); return href ? <a key={index} href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span key={index}>{children}</span>; }
    if (node.tag === 'table') return <div className="document-table" key={index}><table>{children}</table></div>;
    const tag = tags.has(node.tag) ? node.tag : 'span';
    return createElement(tag, { key: index }, ['br', 'hr'].includes(tag) ? undefined : children);
  });
}

export function WebReferenceViewer({ runId, file, refresh = false }: { runId: string; file: ProjectFile; refresh?: boolean }) {
  const { t } = useI18n();
  const id = useId();
  const [mode, setMode] = useState<'reader' | 'original'>('reader');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ article?: ReferenceArticle; error?: string }>({});
  const [originalError, setOriginalError] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const original = webUrl(file.url);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setState({});
    const timer = window.setTimeout(() => controller.abort(), 20000);
    void getReferenceArticle(runId, file.id, controller.signal, refresh || attempt > 0).then(article => {
      if (!disposed) setState({ article });
    }).catch(error => {
      if (!disposed) setState({ error: controller.signal.aborted ? 'Reading the reference page timed out. Please try again or open the original.' : error instanceof Error ? error.message : 'Could not read this reference page.' });
    }).finally(() => window.clearTimeout(timer));
    return () => { disposed = true; window.clearTimeout(timer); controller.abort(); };
  }, [runId, file.id, file.url, attempt, refresh]);
  const loading = !state.article && !state.error;
  const httpError = state.error?.match(/^The source website returned HTTP (\d{3})\.$/u);
  const errorMessage = httpError ? `${t('The source website returned an error.')} (HTTP ${httpError[1]})` : state.error ? t(state.error) : undefined;
  const sandbox = original && new URL(original).origin !== window.location.origin ? 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox' : '';
  return <section className="web-reference-viewer">
    <div className="reference-view-controls" role="tablist" aria-label={t('Reference view')}>
      {(['reader', 'original'] as const).map(value => <button key={value} id={`${id}-${value}`} role="tab" aria-selected={mode === value} aria-controls={`${id}-panel`} onClick={() => setMode(value)}>{t(value === 'reader' ? 'Reader mode' : 'Original page')}</button>)}
    </div>
    <div className={`reference-view-panel${mode === 'original' ? ' original-page-panel' : ''}`} id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${mode}`}>
      {mode === 'reader' ? loading ? <p role="status">{t('Reading reference page…')}</p> : state.error ? <div className="reference-reader-error" role="alert"><p>{errorMessage}</p><p>{t('Try Original page or use Open original to visit the source website.')}</p><button onClick={() => setAttempt(value => value + 1)}>{t('Retry')}</button><button onClick={() => setMode('original')}>{t('Original page')}</button></div> : state.article && <>
        {state.article.embeddingBlocked && <p className="reference-reader-note">{t('This website restricts embedded viewing. Its readable content is shown below.')}</p>}
        <article className="document-markdown reference-article"><header><h1>{state.article.title}</h1>{state.article.byline && <p className="reference-byline">{state.article.byline}</p>}<a href={state.article.url} target="_blank" rel="noopener noreferrer">{state.article.url}</a></header>{articleNodes(state.article.nodes)}</article>
      </> : state.article?.embeddingBlocked ? <div className="reference-reader-error"><p>{t('The source website blocks embedded viewing. Use Reader mode or Open original.')}</p><button onClick={() => setMode('reader')}>{t('Reader mode')}</button></div> : !original || originalError ? <div className="reference-reader-error" role="alert"><p>{t('The original page could not be embedded. Use Reader mode or Open original.')}</p><button onClick={() => setMode('reader')}>{t('Reader mode')}</button></div> : <>
        <button className="reference-reader-fallback" onClick={() => setMode('reader')}>{t('Page not visible? Read the article text')}</button>
        {!originalLoaded && <p role="status">{t('Loading document…')}</p>}
        <iframe className="document-frame" title={file.title} src={original} sandbox={sandbox} referrerPolicy="no-referrer" onLoad={() => setOriginalLoaded(true)} onError={() => setOriginalError(true)} />
      </>}
    </div>
  </section>;
}
