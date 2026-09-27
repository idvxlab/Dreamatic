import { ArrowUp, Check, ChevronDown, Circle, ExternalLink, ImagePlus, LoaderCircle, Paperclip, WandSparkles, X } from "lucide-react";
import { useRef, useState } from "react";
import type { Asset, TimelineItem } from "../types";

export interface PendingImage {
  name: string;
  data: string;
  mimeType: string;
}

interface AgentPanelProps {
  timeline: TimelineItem[];
  streamingText: string;
  running: boolean;
  references?: Asset[];
  onSend: (text: string, images: PendingImage[]) => void;
}

const SUGGESTIONS = [
  "为一个文化展览设计主视觉与海报系统",
  "设计一款克制、可信赖的 AI 硬件产品概念",
  "把我的品牌资料整理成一套视觉方向",
];

export function AgentPanel({ timeline, streamingText, running, references = [], onSend }: AgentPanelProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [referencesOpen, setReferencesOpen] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);

  async function addFiles(files: FileList | null) {
    if (!files) return;
    const next = await Promise.all([...files].filter((file) => file.type.startsWith("image/")).map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      data: await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      }),
    })));
    setImages((current) => [...current, ...next].slice(0, 4));
  }

  function submit() {
    if ((!text.trim() && images.length === 0) || running) return;
    onSend(text.trim() || "请分析这些参考图片，并开始设计。", images);
    setText("");
    setImages([]);
  }

  return (
    <aside className="agent-panel">
      <header className="agent-header">
        <div><span className="agent-sigil"><WandSparkles size={16} /></span><span><strong>Design agent</strong><small><i /> Pi runtime connected</small></span></div>
        <span className="agent-mode">Auto workflow</span>
      </header>
      <div className="agent-scroll">
        {timeline.length === 0 && !streamingText ? (
          <div className="agent-intro">
            <p className="eyebrow">Start with an outcome</p>
            <h2>What should we design?</h2>
            <p>Describe the audience, context, deliverables, and constraints. The agent will load the matching design workflow.</p>
            <div className="suggestions">{SUGGESTIONS.map((item) => <button key={item} onClick={() => setText(item)}>{item}</button>)}</div>
          </div>
        ) : (
          <div className="timeline">
            {references.length > 0 && (
              <section className={`reference-block ${referencesOpen ? "open" : ""}`}>
                <button className="reference-summary" onClick={() => setReferencesOpen((open) => !open)} aria-expanded={referencesOpen}>
                  <span><ImagePlus size={14} /><span><strong>Reference library</strong><small>{references.length} image{references.length === 1 ? "" : "s"} collected for this Run</small></span></span>
                  <ChevronDown size={15} />
                </button>
                {referencesOpen && <div className="reference-grid">{references.map((asset) => (
                  <a key={asset.path} href={`/assets/${encodeURIComponent(asset.path)}`} target="_blank" rel="noreferrer">
                    <img src={`/assets/${encodeURIComponent(asset.path)}`} alt="" />
                    <span>{asset.label}<ExternalLink size={11} /></span>
                  </a>
                ))}</div>}
              </section>
            )}
            {timeline.map((item) => (
              <div className={`timeline-item ${item.kind}`} key={item.id}>
                <span className="timeline-dot">{item.active ? <LoaderCircle className="spin" size={14} /> : item.kind === "error" ? <X size={13} /> : item.kind === "result" ? <Check size={13} /> : <Circle size={9} fill="currentColor" />}</span>
                <div><strong>{item.label}{item.retryCount && item.retryCount > 1 ? ` · ${item.retryCount} attempts` : ""}</strong>{item.stage && <span className="stage-pill">{item.stage}</span>}{item.detail && <p>{item.detail}</p>}</div>
              </div>
            ))}
            {streamingText && <div className="assistant-copy">{streamingText}</div>}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {images.length > 0 && <div className="attachment-row">{images.map((image, index) => <span key={`${image.name}-${index}`}><ImagePlus size={13} />{image.name}<button onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={11} /></button></span>)}</div>}
        <div className="composer">
          <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="Describe the design outcome…" rows={3} />
          <div>
            <button className="attach" onClick={() => fileRef.current?.click()}><Paperclip size={17} /></button>
            <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(event) => addFiles(event.target.files)} />
            <span>Enter to send</span>
            <button className="send" disabled={running || (!text.trim() && images.length === 0)} onClick={submit}>{running ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={17} />}</button>
          </div>
        </div>
      </div>
    </aside>
  );
}
