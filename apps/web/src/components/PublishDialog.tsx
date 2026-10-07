import { usePublication, setPublicationPosting } from "../publication-state";
import { useI18n } from "../i18n";
import { LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { publishProject, type PublishProgress, type PublishCreator } from "../api";

export function PublishDialog({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const creatorLoaded = useRef(false);
  const publication = usePublication(runId);
  const status = publication.status;
  const [creator, setCreator] = useState<PublishCreator>(status?.creator ?? { name: "", affiliation: "", website: "" });
  const [confirmed, setConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [progress, setProgress] = useState<PublishProgress>();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ previewUrl: string; galleryUrl: string }>();
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { previousFocus?.focus(); };
  }, [runId]);
  useEffect(() => {
    if (status && !creatorLoaded.current) { creatorLoaded.current = true; if (status.creator) setCreator(status.creator); }
    if (!submitting.current) {
      setPublishing(Boolean(status?.inProgress));
      if (publishing && status?.progress?.phase === "completed" && status.receipt) setResult(status.receipt);
      else if (status?.progress?.phase === "failed") setError(status.progress.error);
    }
    if (status?.inProgress) setProgress(status.progress);
  }, [status]);
  useEffect(() => {
    if (!publishing) return;
    const preventLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLeave);
    return () => window.removeEventListener("beforeunload", preventLeave);
  }, [publishing]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!confirmed || publishing || submitting.current || !status || status.inProgress) return;
    submitting.current = true; setPublishing(true); setError(undefined); setProgress({ phase: "packaging", uploadedBytes: 0, totalBytes: 0 });
    setPublicationPosting(runId, true);
    let continues = false;
    try { setResult(await publishProject(runId, creator, status.mayExist)); }
    catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setConfirmed(false);
      const value = await publication.refresh(); continues = Boolean(value?.inProgress);
    } finally { submitting.current = false; setPublicationPosting(runId, false); setPublishing(continues); void publication.refresh(); }
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
      {(error || publication.error) && <p role="alert">{error || publication.error}</p>}
      {!status && publication.error && <button type="button" onClick={() => void publication.refresh()}>{t("Retry")}</button>}
      <footer><button type="button" disabled={publishing} onClick={onClose}>{result ? t("Done") : t("Cancel")}</button>{!result && <button type="submit" className="primary" disabled={!confirmed || publishing || !status}>{publishing ? t("Publishing…") : t(status?.mayExist ? "Confirm & Replace" : "Confirm & Publish")}</button>}</footer>
    </form>
  </dialog>;
}
