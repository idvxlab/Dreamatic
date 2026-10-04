import { ArrowUp, Bot, Check, ChevronDown, Circle, ExternalLink, ImagePlus, LoaderCircle, Paperclip, Square, WandSparkles, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { assetUrl } from "../asset-url";
import type { ClarificationRequest, TimelineItem, WorkflowEvent } from "../types";

export interface PendingImage {
  name: string;
  data: string;
  mimeType: string;
}

interface AgentPanelProps {
  timeline: TimelineItem[];
  workflow?: WorkflowEvent[];
  streamingText: string;
  running: boolean;
  stopping: boolean;
  pendingAgentStatus?: string;
  clarification?: ClarificationRequest;
  onSend: (text: string, images: PendingImage[]) => void;
  onStop: () => void;
  onAnswerClarification: (answers: Record<string, string>) => void;
  onDismissClarification: () => void;
}

const SUGGESTIONS = [
  "为一个文化展览设计主视觉与海报系统",
  "设计一款克制、可信赖的 AI 硬件产品概念",
  "把我的品牌资料整理成一套视觉方向",
];

function timeLabel(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ArtifactLinks({ paths = [] }: { paths?: string[] }) {
  if (!paths.length) return null;
  const images = paths.filter((path) => /\.(png|jpe?g|webp|gif)$/i.test(path));
  return <section className="workflow-artifacts"><h4>Artifacts</h4>
    {images.length > 0 && <div className="workflow-image-grid">{images.map((path) => <a key={path} href={assetUrl(path)} target="_blank" rel="noreferrer"><img src={assetUrl(path)} alt="" /><span>{path.split("/").at(-1)}</span></a>)}</div>}
    <div className="workflow-file-links">{paths.filter((path) => !images.includes(path)).map((path) => <a key={path} href={assetUrl(path)} target="_blank" rel="noreferrer">{path}<ExternalLink size={10} /></a>)}</div>
  </section>;
}

function WorkflowDetails({ event }: { event: WorkflowEvent }) {
  return <div className="workflow-details">
    {event.detail && <p>{event.detail}</p>}
    {event.input && <section><h4>Input</h4><pre>{event.input}</pre></section>}
    {event.output && event.kind !== "agent" && <section><h4>Result</h4><pre>{event.output}</pre></section>}
    <ArtifactLinks paths={event.artifactRefs} />
  </div>;
}

function WorkflowNode({ event, nested = false }: { event: WorkflowEvent; nested?: boolean }) {
  const at = timeLabel(event.at);
  const [agentOpen, setAgentOpen] = useState(event.status === "running");
  if (event.kind === "message") {
    const user = event.actor === "User / CLI" || event.actor === "User";
    return <div className={`workflow-message-row ${user ? "user" : "assistant"}`}>
      <div className="workflow-message-bubble">
        <small>{user ? "You" : event.actor}{at ? ` · ${at}` : ""}</small>
        {event.detail && <p>{event.detail}</p>}
        <ArtifactLinks paths={event.artifactRefs} />
      </div>
    </div>;
  }
  if (event.kind === "agent") return <div className={`workflow-node workflow-agent-node ${event.status} ${nested ? "nested" : ""}`}>
    <span className="workflow-dot"><Bot size={13} /></span>
    <details className="workflow-agent-card" open={agentOpen} onToggle={(toggleEvent) => {
      const target = toggleEvent.currentTarget;
      const open = target.open;
      setAgentOpen(open);
      if (open) window.requestAnimationFrame(() => target.scrollIntoView({ block: "start", behavior: "smooth" }));
    }}>
      <summary><span><strong>{event.label}</strong><small>{event.actionCount ?? event.children?.filter((child) => child.kind === "tool").length ?? 0} actions · {event.status}{at ? ` · ${at}` : ""}</small>{event.status === "running" && event.output && <small>{event.output}</small>}</span><ChevronDown size={14} /></summary>
      <div className="workflow-agent-body">
        {event.detail && <section className="workflow-assignment"><h4>Assigned by Orchestrator</h4><p>{event.detail}</p></section>}
        {event.children?.length ? <div className="workflow-stream nested-stream">{event.children.map((child) => <WorkflowNode event={child} nested key={child.id} />)}</div> : null}
        {event.output && <section className="workflow-agent-output"><h4>Agent output</h4><p>{event.output}</p></section>}
      </div>
    </details>
  </div>;

  if (event.kind === "references") return <div className={`workflow-node workflow-reference-node ${nested ? "nested" : ""}`}>
    <span className="workflow-dot"><ImagePlus size={13} /></span>
    <details className="workflow-reference-card"><summary><span><strong>{event.label}</strong><small>{event.assets?.length ?? 0} images{at ? ` · ${at}` : ""}</small></span><ChevronDown size={14} /></summary>
      <div><p>{event.detail}</p><div className="workflow-reference-grid">{event.assets?.map((asset) => <a key={asset.path} href={assetUrl(asset.path)} target="_blank" rel="noreferrer"><img src={assetUrl(asset.path)} alt="" /><span>{asset.label}<ExternalLink size={10} /></span></a>)}</div></div>
    </details>
  </div>;

  const expandable = Boolean(event.detail || event.input || event.output || event.artifactRefs?.length);
  const heading = <span className="workflow-label"><strong>{event.label}</strong><small>{event.actor}{event.stage ? ` · ${event.stage}` : ""}{at ? ` · ${at}` : ""}</small></span>;
  return <div className={`workflow-node kind-${event.kind} ${event.status} ${nested ? "nested" : ""}`}>
    <span className="workflow-dot">{event.kind === "tool" ? <Wrench size={11} /> : event.status === "running" ? <LoaderCircle className="spin" size={13} /> : event.status === "error" || event.status === "interrupted" ? <X size={12} /> : <Check size={12} />}</span>
    {expandable ? <details className="workflow-event-card"><summary>{heading}<ChevronDown size={12} /></summary><WorkflowDetails event={event} /></details> : <div className="workflow-event-label">{heading}</div>}
  </div>;
}

function ClarificationCard({ request, disabled, onSubmit, onDismiss }: { request: ClarificationRequest; disabled: boolean; onSubmit: (answers: Record<string, string>) => void; onDismiss: () => void }) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  useEffect(() => { setSelected({}); setCustom({}); }, [request.id]);
  const answerFor = (id: string) => [...(selected[id] ?? []), ...(custom[id]?.trim() ? [custom[id].trim()] : [])].join("、");
  const ready = request.questions.every((question) => !question.required || Boolean(answerFor(question.id)));
  const toggle = (questionId: string, label: string, multiple: boolean) => setSelected((current) => {
    const values = current[questionId] ?? [];
    if (!multiple) return { ...current, [questionId]: [label] };
    return { ...current, [questionId]: values.includes(label) ? values.filter((value) => value !== label) : [...values, label] };
  });
  return <section className="clarification-card" aria-label="Design brief questions">
    <div className="clarification-heading"><span><Bot size={14} /></span><div><strong>{request.title}</strong>{request.context && <p>{request.context}</p>}</div><button type="button" onClick={onDismiss} aria-label="关闭需求确认，返回对话" title="关闭需求确认，返回对话"><X size={14} /></button></div>
    <div className="clarification-questions">{request.questions.map((question, index) => <fieldset key={question.id}>
      <legend><em>{index + 1}</em><span><b>{question.header}</b>{question.question}</span>{question.multiple && <small>Multiple</small>}{!question.required && <small>Optional</small>}</legend>
      {question.options?.length ? <div className="clarification-options">{question.options.map((option) => <button type="button" className={(selected[question.id] ?? []).includes(option.label) ? "selected" : ""} onClick={() => toggle(question.id, option.label, question.multiple)} key={option.label}><strong>{option.label}</strong><small>{option.description}</small></button>)}</div> : null}
      {question.custom && <input value={custom[question.id] ?? ""} onChange={(event) => setCustom((current) => ({ ...current, [question.id]: event.target.value }))} placeholder={question.placeholder ?? (question.options?.length ? "Or enter another answer…" : "Type your answer…")} />}
    </fieldset>)}</div>
    <button className="clarification-submit" type="button" disabled={disabled || !ready} onClick={() => onSubmit(Object.fromEntries(request.questions.map((question) => [question.id, answerFor(question.id)])))}>{disabled ? "Waiting for agent…" : "Continue workflow"}<ArrowUp size={13} /></button>
  </section>;
}

export function AgentPanel({ timeline, workflow = [], streamingText, running, stopping, pendingAgentStatus, clarification, onSend, onStop, onAnswerClarification, onDismissClarification }: AgentPanelProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);

  useEffect(() => {
    if (!followOutputRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [timeline, workflow, streamingText, pendingAgentStatus, clarification, running]);

  useEffect(() => {
    if (!running) return;
    followOutputRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (element) element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [running]);

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
        {running
          ? <button className="agent-stop" type="button" onClick={onStop} disabled={stopping} title="Stop the current run"><Square size={10} fill="currentColor" /> {stopping ? "Stopping…" : "Stop"}</button>
          : <span className="agent-mode">Auto workflow</span>}
      </header>
      <div className="agent-scroll" ref={scrollRef} onScroll={(event) => {
        const element = event.currentTarget;
        followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
      }}>
        {timeline.length === 0 && workflow.length === 0 && !streamingText ? (
          <div className="agent-intro">
            <p className="eyebrow">Start with an outcome</p>
            <h2>What should we design?</h2>
            <p>Describe the audience, context, deliverables, and constraints. The agent will load the matching design workflow.</p>
            <div className="suggestions">{SUGGESTIONS.map((item) => <button key={item} onClick={() => setText(item)}>{item}</button>)}</div>
          </div>
        ) : (
          <div>
            {workflow.length > 0 ? <div className="workflow-stream">{workflow.map((event) => <WorkflowNode event={event} key={event.id} />)}{pendingAgentStatus && <div className="workflow-node workflow-thinking-node running"><span className="workflow-dot"><LoaderCircle className="spin" size={13} /></span><div className="workflow-thinking-card"><strong>{pendingAgentStatus}</strong><small>Orchestrator · working</small><i><span /><span /><span /></i></div></div>}</div> : <div className="timeline">{timeline.map((item) => {
              const expandable = Boolean(item.detail || item.artifactRefs?.length);
              const heading = <span className="timeline-label"><strong>{item.label}{item.retryCount && item.retryCount > 1 ? ` · ${item.retryCount} attempts` : ""}</strong>{item.stage && <span className="stage-pill">{item.stage}</span>}</span>;
              return <div className={`timeline-item ${item.kind}`} key={item.id}>
                <span className="timeline-dot">{item.active ? <LoaderCircle className="spin" size={14} /> : item.kind === "error" ? <X size={13} /> : item.kind === "result" ? <Check size={13} /> : <Circle size={9} fill="currentColor" />}</span>
                {expandable ? <details className="timeline-details"><summary>{heading}<ChevronDown size={12} /></summary><div className="timeline-expanded">{item.detail && <p>{item.detail}</p>}<ArtifactLinks paths={item.artifactRefs} /></div></details> : <div className="timeline-heading">{heading}</div>}
              </div>;
            })}{pendingAgentStatus && <div className="workflow-node workflow-thinking-node running"><span className="workflow-dot"><LoaderCircle className="spin" size={13} /></span><div className="workflow-thinking-card"><strong>{pendingAgentStatus}</strong><small>Orchestrator · working</small><i><span /><span /><span /></i></div></div>}</div>}
            {streamingText && <div className="assistant-copy">{streamingText}</div>}
          </div>
        )}
      </div>
      <div className="composer-wrap">
        {clarification ? <ClarificationCard request={clarification} disabled={running} onSubmit={onAnswerClarification} onDismiss={onDismissClarification} /> : <>
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
        </>}
      </div>
    </aside>
  );
}
