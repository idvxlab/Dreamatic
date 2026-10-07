import { useI18n } from "../i18n";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getPublicationStatus, publishProject, type PublicationStatus, type PublishProgress, type PublishCreator } from "../api";

export function PublishDialog({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [status, setStatus] = useState<PublicationStatus>();
  const [creator, setCreator] = useState<PublishCreator>({ name: "", affiliation: "", website: "" });
  const [confirmed, setConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<PublishProgress>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ previewUrl: string; galleryUrl: string }>();
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    let active = true;
    void getPublicationStatus(runId).then(value => {
      if (!active) return;
      setStatus(value); if (value.creator) setCreator(value.creator);
      if (value.inProgress) { setPublishing(true); setProgress(value.progress); }
    }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; previousFocus?.focus(); };
  }, [runId]);
  useEffect(() => {
    if (!publishing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await getPublicationStatus(runId);
        if (!active) return;
        setProgress(value.progress);
        if (!submitting.current && !value.inProgress) {
          setPublishing(false); setStatus(value);
          if (value.progress?.phase === "completed" && value.receipt) setResult(value.receipt);
          else if (value.progress?.phase === "failed") setError(value.progress.error);
        }
      } catch { /* Keep the operation locked while its POST is pending. */ }
      if (active) timer = setTimeout(() => void poll(), 750);
    };
    void poll();
    const preventLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeave);
    return () => { active = false; clearTimeout(timer); window.removeEventListener("beforeunload", preventLeave); };
  }, [publishing, runId]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed || publishing || submitting.current || !status || status.inProgress) return;
    submitting.current = true; setPublishing(true); setError(undefined); setProgress({ phase: "packaging", uploadedBytes: 0, totalBytes: 0 });
    let continues = false;
    try { setResult(await publishProject(runId, creator, status.mayExist)); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setConfirmed(false);
      try { const value = await getPublicationStatus(runId); setStatus(value); continues = value.inProgress; } catch { setStatus(undefined); }
    } finally { submitting.current = false; setPublishing(continues); }
  }
  const percent = progress?.totalBytes ? Math.min(100, Math.floor(progress.uploadedBytes / progress.totalBytes * 100)) : 0;
  const phase = progress?.phase ?? "packaging";
  const label = phase === "uploading" ? "Uploading project…" : phase === "deploying" ? "Upload complete. Waiting for website deployment…" : phase === "completed" ? "Publication complete" : "Packaging project…";
  return <dialog ref={dialog} className="publish-dialog" aria-labelledby="publish-title" aria-busy={publishing} onCancel={event => { if (publishing) event.preventDefault(); else onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id="publish-title">{t("Publish to DreamaticSite")}</h2><button type="button" className="publish-close" aria-label={t("Close publication dialog")} disabled={publishing} onClick={onClose}><X size={16} strokeWidth={1.7} /></button></header>
      {result ? <div role="status"><p>“{title}{t("” has been published.")}</p><a href={result.previewUrl} target="_blank" rel="noreferrer">{t("Open published design")}</a><a href={result.galleryUrl} target="_blank" rel="noreferrer">{t("View Gallery")}</a></div> : <>
        <p><strong>{title}</strong></p><p>{t("Destination:")} {status?.site ?? t("Loading…")}</p>
        {status?.mayExist && <p className="publish-overwrite" role="note">{t(status.published ? "This project has already been published. Publishing again will replace its previous contents at the same website address." : "A previous publication attempt exists. If it reached the website, publishing again will replace that version.")}</p>}
        <p>{t("The complete project export, including design outputs, source files and reference materials, will be uploaded. Design assets will be publicly viewable in Gallery. Sessions and system credentials are excluded.")}</p>
        <fieldset disabled={publishing}><legend>{t("Creator · optional")}</legend>
          <label>{t("Name")}<input autoComplete="name" maxLength={80} value={creator.name} onChange={event => setCreator({ ...creator, name: event.target.value })} /></label>
          <label>{t("Organization")}<input autoComplete="organization" maxLength={160} value={creator.affiliation} onChange={event => setCreator({ ...creator, affiliation: event.target.value })} /></label>
          <label>{t("Website")}<input type="url" placeholder="https://" maxLength={500} value={creator.website} onChange={event => setCreator({ ...creator, website: event.target.value })} /></label>
        </fieldset>
        <p>{t("Leave the name blank to publish as Anonymous. Creator details are self-declared and do not sign you in.")}</p>
        <label className="publish-consent"><input type="checkbox" disabled={publishing || !status} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t(status?.mayExist ? "I confirm publication and replacement of this project's previous published contents." : "I confirm that I want to publish this project and may publicly share its contents.")}</label>
      </>}
      {publishing && <section className="publish-progress" role="status" aria-live="polite"><span><LoaderCircle size={15} className="spin" />{t(label)}{phase === "uploading" ? ` ${percent}%` : ""}</span><progress aria-label={t("Publication progress")} max={100} value={phase === "packaging" ? undefined : percent} /><small>{t("Please wait. Keep this window open until publication finishes.")}</small></section>}
      {error && <p role="alert">{error}</p>}
      {!status && error && <button type="button" onClick={() => { setError(undefined); void getPublicationStatus(runId).then(setStatus).catch(reason => setError(String(reason))); }}>{t("Retry")}</button>}
      <footer><button type="button" disabled={publishing} onClick={onClose}>{result ? t("Done") : t("Cancel")}</button>{!result && <button type="submit" className="primary" disabled={!confirmed || publishing || !status}>{publishing ? t("Publishing…") : t(status?.mayExist ? "Confirm & Replace" : "Confirm & Publish")}</button>}</footer>
    </form>
  </dialog>;
}
