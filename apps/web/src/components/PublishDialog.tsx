import { useI18n, LanguageToggle } from "../i18n";
import { useEffect, useRef, useState } from "react";
import { getRuntimeConfig, publishProject, type PublishCreator } from "../api";

export function PublishDialog({ runId, title, onClose }: { runId: string; title: string; onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [site, setSite] = useState<string>();
  const [creator, setCreator] = useState<PublishCreator>({ name: "", affiliation: "", website: "" });
  const [confirmed, setConfirmed] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<{ previewUrl: string; galleryUrl: string }>();
  const publicationId = useRef(crypto.randomUUID());
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    let active = true;
    void getRuntimeConfig().then(config => { if (active) setSite(config.values.DREAMATIC_SITE_URL || ""); }).catch(reason => { if (active) setError(String(reason)); });
    return () => { active = false; previousFocus?.focus(); };
  }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); if (!confirmed || publishing || !site) return;
    setPublishing(true); setError(undefined);
    try { setResult(await publishProject(runId, creator, publicationId.current)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setPublishing(false); }
  }
  return <dialog ref={dialog} className="publish-dialog" aria-labelledby="publish-title" onCancel={event => { if (publishing) event.preventDefault(); else onClose(); }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id="publish-title">{t("Publish to DreamaticSite")}</h2><LanguageToggle /><button type="button" aria-label={t("Close publication dialog")} disabled={publishing} onClick={onClose}>×</button></header>
      {result ? <div role="status"><p>“{title}{t("” has been published.")}</p><a href={result.previewUrl} target="_blank" rel="noreferrer">{t("Open published design")}</a><a href={result.galleryUrl} target="_blank" rel="noreferrer">{t("View Gallery")}</a></div> : <>
        <p><strong>{title}</strong></p><p>{t("Destination:")} {site === undefined ? t("Loading…") : site || t("Not configured — set DreamaticSite URL in Settings")}</p>
        <p>{t("The complete project export, including design outputs, source files and reference materials, will be uploaded. Design assets will be publicly viewable in Gallery. Sessions and system credentials are excluded.")}</p>
        <fieldset disabled={publishing}><legend>{t("Creator · optional")}</legend>
          <label>{t("Name")}<input autoComplete="name" maxLength={80} value={creator.name} onChange={event => setCreator({ ...creator, name: event.target.value })} /></label>
          <label>{t("Organization")}<input autoComplete="organization" maxLength={160} value={creator.affiliation} onChange={event => setCreator({ ...creator, affiliation: event.target.value })} /></label>
          <label>{t("Website")}<input type="url" placeholder="https://" maxLength={500} value={creator.website} onChange={event => setCreator({ ...creator, website: event.target.value })} /></label>
        </fieldset>
        <p>{t("Leave the name blank to publish as Anonymous. Creator details are self-declared and do not sign you in.")}</p>
        <label className="publish-consent"><input type="checkbox" disabled={publishing} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{t("I confirm that I want to publish this project and may publicly share its contents.")}</label>
      </>}
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={publishing} onClick={onClose}>{result ? t("Done") : t("Cancel")}</button>{!result && <button type="submit" className="primary" disabled={!confirmed || publishing || !site}>{publishing ? t("Packaging & publishing…") : t("Confirm & Publish")}</button>}</footer>
    </form>
  </dialog>;
}
