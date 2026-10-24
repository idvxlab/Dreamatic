import { marked, type Token, type Tokens } from 'marked';
import type { ReactNode } from 'react';
import { assetUrl } from '../asset-url';

function safeUrl(value: string, path?: string): string | undefined {
  try {
    const base = path ? new URL(assetUrl(path), window.location.origin) : new URL(window.location.href);
    const url = new URL(value, base);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}
/** Render parser tokens as React nodes. Raw HTML stays text, including inline HTML. */
export function MarkdownDocument({ text, path }: { text: string; path?: string }) {
  function render(tokens: Token[]): ReactNode[] {
    return tokens.map((token, index) => {
      const children = 'tokens' in token && token.tokens ? render(token.tokens) : 'text' in token ? token.text : '';
      switch (token.type) {
        case 'space': return null;
        case 'heading': { const Tag = `h${Math.min(6, token.depth)}` as 'h1'; return <Tag key={index}>{children}</Tag>; }
        case 'paragraph': return <p key={index}>{children}</p>;
        case 'strong': return <strong key={index}>{children}</strong>;
        case 'em': return <em key={index}>{children}</em>;
        case 'del': return <del key={index}>{children}</del>;
        case 'codespan': return <code key={index}>{token.text}</code>;
        case 'code': return <pre key={index}><code>{token.text}</code></pre>;
        case 'blockquote': return <blockquote key={index}>{children}</blockquote>;
        case 'br': return <br key={index} />;
        case 'hr': return <hr key={index} />;
        case 'link': { const url = safeUrl(token.href, path); return url ? <a key={index} href={url} target="_blank" rel="noopener noreferrer">{children}</a> : <span key={index}>{children}</span>; }
        case 'image': { const url = safeUrl(token.href, path); return url && !url.startsWith('mailto:') ? <img key={index} src={url} alt={token.text} loading="lazy" /> : <span key={index}>{token.text}</span>; }
        case 'list': {
          const items = token.items.map((item: Tokens.ListItem, i: number) => <li key={i}>{item.task && <input type="checkbox" checked={Boolean(item.checked)} readOnly aria-label={item.text} />}{render(item.tokens)}</li>);
          return token.ordered ? <ol key={index} start={token.start || 1}>{items}</ol> : <ul key={index}>{items}</ul>;
        }
        case 'table': return <div className="document-table" key={index}><table><thead><tr>{token.header.map((cell: Tokens.TableCell, i: number) => <th key={i}>{render(cell.tokens)}</th>)}</tr></thead><tbody>{token.rows.map((row: Tokens.TableCell[], i: number) => <tr key={i}>{row.map((cell: Tokens.TableCell, j: number) => <td key={j}>{render(cell.tokens)}</td>)}</tr>)}</tbody></table></div>;
        case 'html': return <span key={index}>{token.raw}</span>;
        default: return <span key={index}>{children}</span>;
      }
    });
  }
  return <article className="document-markdown">{render(marked.lexer(text))}</article>;
}
