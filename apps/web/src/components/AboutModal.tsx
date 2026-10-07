import { createPortal } from "react-dom";
import { useEffect, useRef } from "react";
import { Sparkles, X } from "lucide-react";
import { useI18n } from "../i18n";
import { APP_VERSION, VERSION_REPOSITORY_URL } from "../app-info";

export function AboutModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  return createPortal(<div className="modal-backdrop config-backdrop" onMouseDown={onClose}>
    <section ref={dialog} className="about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key === "Escape") onClose();
      if (event.key === "Tab") {
        const controls = [...dialog.current!.querySelectorAll<HTMLElement>("button, a")];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <button className="about-close" aria-label={t("Close about")} onClick={onClose}><X size={17} /></button>
      <div className="about-mark"><Sparkles size={30} strokeWidth={1.6} /></div>
      <h2 id="about-title">DreamaticArt</h2>
      <p className="about-version">{t("Version")} {APP_VERSION}</p>
      <p className="about-description">{t("A professional AI design-agent system for UX/UI, product, brand, visual and spatial design.")}</p>
      <dl><div><dt>{t("Created by")}</dt><dd><a href="https://idvxlab.com/" target="_blank" rel="noopener noreferrer">Intelligent Design &amp; Innovation Lab</a></dd></div><div><dt>{t("License")}</dt><dd>MIT</dd></div></dl>
      <div className="about-links"><a href="https://www.dreamatic.art/" target="_blank" rel="noopener noreferrer">{t("Official website")}</a><a href={VERSION_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">GitHub</a></div>
      <small className="about-copyright">© 2026 IDVX Lab and contributors</small>
    </section>
  </div>, document.body);
}
