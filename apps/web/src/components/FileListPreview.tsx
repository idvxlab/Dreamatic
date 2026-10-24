import { useState } from 'react';
import { AlignLeft, Box, File, FileCode2, FileJson, FilePenLine, FileSpreadsheet, FileText, FileType2, Film, Globe, Image, Presentation, VectorSquare, type LucideIcon } from 'lucide-react';
import { assetUrl } from '../asset-url';
import { projectFileUrl } from '../api';
import { useI18n } from '../i18n';
import type { ProjectFile } from '../types';

interface FileAppearance { icon: LucideIcon; label: string }
const appearances: Record<string, FileAppearance> = {
  md: { icon: FilePenLine, label: 'Markdown document' },
  txt: { icon: AlignLeft, label: 'Plain text file' },
  json: { icon: FileJson, label: 'JSON data file' },
  html: { icon: FileCode2, label: 'HTML document' },
  htm: { icon: FileCode2, label: 'HTML document' },
  pdf: { icon: FileType2, label: 'PDF document' },
  svg: { icon: VectorSquare, label: 'Vector image' },
  web: { icon: Globe, label: 'Web reference' },
};
for (const kind of ['png', 'jpg', 'jpeg', 'webp', 'gif']) appearances[kind] = { icon: Image, label: 'Image file' };
for (const kind of ['mp4', 'webm', 'mov']) appearances[kind] = { icon: Film, label: 'Video file' };
for (const kind of ['doc', 'docx']) appearances[kind] = { icon: FileText, label: 'Word document' };
for (const kind of ['xls', 'xlsx', 'csv']) appearances[kind] = { icon: FileSpreadsheet, label: 'Spreadsheet file' };
for (const kind of ['ppt', 'pptx']) appearances[kind] = { icon: Presentation, label: 'Presentation file' };
for (const kind of ['glb', 'gltf']) appearances[kind] = { icon: Box, label: '3D model' };

function imageUrl(value?: string): string | undefined {
  if (!value) return;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
  } catch { /* Missing or unsupported preview addresses fall back to the file icon. */ }
}

export function FileListPreview({ file, runId }: { file: ProjectFile; runId?: string }) {
  const { t } = useI18n();
  const kind = file.kind.toLowerCase().replace(/^\./u, '');
  const { icon: Icon, label } = appearances[kind] ?? { icon: File, label: 'Other file' };
  const [failed, setFailed] = useState<string>();
  let source = imageUrl(file.thumbnailUrl);
  if (!source && /^(png|jpe?g|webp|gif|svg)$/u.test(kind)) {
    if (runId && file.path) source = assetUrl(`runs/${runId}/${file.path}`);
    else if (runId && !file.url) source = projectFileUrl(runId, file.id);
    else source = imageUrl(file.url);
    if (source?.startsWith('/') && file.modifiedAt) source += `${source.includes('?') ? '&' : '?'}v=${encodeURIComponent(file.modifiedAt)}`;
  }
  const version = `${runId}:${file.id}:${file.modifiedAt}:${source}`;
  const badge = kind === 'web' ? 'WEB' : kind && kind.length <= 5 ? kind.toUpperCase() : 'FILE';
  const thumbnail = source && failed !== version;
  return <span className="file-list-preview" role="img" aria-label={t(label)} title={`${t(label)} · ${badge}`}>
    {thumbnail ? <img key={version} src={source} alt="" loading="lazy" decoding="async" onError={() => setFailed(version)} /> : <><Icon size={21} aria-hidden="true" /><span className="file-type-badge" aria-hidden="true">{badge}</span></>}
  </span>;
}
