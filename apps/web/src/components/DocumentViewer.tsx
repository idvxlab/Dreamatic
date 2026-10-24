import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { assetUrl } from '../asset-url';
import { projectFileUrl } from '../api';
import { useI18n } from '../i18n';
import type { ProjectFile } from '../types';
import { WebReferenceViewer } from './WebReferenceViewer';
import { MarkdownDocument } from './MarkdownDocument';

export function DocumentViewer({ runId, file }: { runId?: string; file?: ProjectFile }) {
  const { t } = useI18n();
  const [retry, setRetry] = useState(0);
  const key = `${runId}:${file?.id}:${file?.modifiedAt ?? file?.metadata}:${file?.url}:${retry}`;
  const activeKey = useRef(key); activeKey.current = key;
  const [content, setContent] = useState<{ key: string; text?: string; error?: string; loaded?: boolean }>();
  const url = file?.url ?? (runId && file ? (file.path && ['html', 'htm'].includes(file.kind) ? assetUrl(`runs/${runId}/${file.path}`) : projectFileUrl(runId, file.id)) : undefined);
  const textKind = Boolean(file && ['md', 'txt', 'json', 'csv'].includes(file.kind));
  useEffect(() => {
    if (!file || !runId || !url || !textKind) return;
    const controller = new AbortController();
    setContent({ key });
    void fetch(url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error(t('Could not load this document'));
      const text = await response.text();
      if (!controller.signal.aborted) setContent({ key, text, loaded: true });
    }).catch(error => { if (!controller.signal.aborted) setContent({ key, error: String(error instanceof Error ? error.message : error) }); });
    return () => controller.abort();
  }, [key, url, textKind, runId]);
  if (!file || !runId || !url) return <section className="document-viewer document-empty"><FileText size={28} /><h2>{t('Select a file to read')}</h2><p>{t('Choose an item from the tool panel.')}</p></section>;
  const current = content?.key === key ? content : undefined;
  const error = current?.error;
  const fail = () => { if (activeKey.current === key) setContent({ key, error: t('This content could not be displayed. Open the original file or link.') }); };
  const loaded = () => { if (activeKey.current === key) setContent({ key, loaded: true }); };
  const embedded = /^(png|jpe?g|webp|gif|svg|mp4|webm|mov|html|htm|pdf)$/u.test(file.kind);
  let body;
  if (file.kind === 'web') body = <WebReferenceViewer key={key} runId={runId} file={file} refresh={retry > 0} />;
  else if (textKind) {
    let text = current?.text;
    if (file.kind === 'json' && text) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* Preserve malformed historical text for reading. */ } }
    body = !current?.loaded ? <p role="status">{t('Loading document…')}</p> : !text?.trim() ? <p>{t('This document is empty')}</p> : file.kind === 'md' ? <MarkdownDocument text={text} path={file.path ? `runs/${runId}/${file.path}` : undefined} /> : <pre className="document-text">{text}</pre>;
  } else if (/^(png|jpe?g|webp|gif|svg)$/u.test(file.kind)) body = <img key={key} className="document-image" src={url} alt={file.title} onLoad={loaded} onError={fail} />;
  else if (/^(mp4|webm|mov)$/u.test(file.kind)) body = <video key={key} controls className="document-video" src={url} onLoadedData={loaded} onError={fail} />;
  else if (['html', 'htm', 'pdf'].includes(file.kind)) body = <>
    <iframe key={key} className="document-frame" title={file.title} src={url} sandbox={file.kind === 'pdf' ? undefined : ''} referrerPolicy="no-referrer" onLoad={loaded} onError={fail} />
  </>;
  else body = <p>{t('Preview is unavailable for this format. Open or download the original file.')}</p>;
  return <section className="document-viewer">
    <header className="document-header"><div><strong>{file.title}</strong><small>{file.path ?? file.url ?? t(file.group)}</small></div><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />{t('Open original')}</a><button onClick={() => setRetry(value => value + 1)} aria-label={t('Reload document')}><RefreshCw size={14} /></button></header>
    {file.category === 'references' && file.metadata && <details className="document-metadata"><summary>{t('Source details')}</summary><pre>{file.metadata}</pre></details>}
    <div className="document-body">{embedded && !current?.loaded && !error && <p role="status">{t('Loading document…')}</p>}{error ? <p role="alert">{error}</p> : body}</div>
  </section>;
}
