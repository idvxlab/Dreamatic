import { useI18n } from "../i18n";
import { Save, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RuntimeConfig } from "../api";
interface SettingsModalProps { initial: RuntimeConfig; onClose: () => void; onSave: (config: RuntimeConfig & { textApiKey?: string; searchApiKey?: string; imageApiKey?: string }) => Promise<void> }
export function SettingsModal({ initial, onClose, onSave }: SettingsModalProps) {
  const { t } = useI18n();
  const [values, setValues] = useState(initial.values);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [module, setModule] = useState(initial.modules[0]!.id);
  const [saving, setSaving] = useState(false), [error, setError] = useState<string>();
  const dialog = useRef<HTMLElement>(null);
  useEffect(() => { dialog.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus(); }, []);
  async function submit() {
    setSaving(true); setError(undefined);
    try { await onSave({ ...initial, values: Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== initial.values[key])), secrets }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("Could not save configuration")); }
    finally { setSaving(false); }
  }
  const fields = initial.fields.filter((field) => field.module === module);
  const activeModule = initial.modules.find((item) => item.id === module)!;
  return <div className="modal-backdrop config-backdrop" role="presentation" onMouseDown={() => { if (!saving) onClose(); }}>
    <section ref={dialog} className="settings-modal config-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      if (event.key === "Escape" && !saving) onClose();
      if (event.key === "Tab") { const controls = [...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')]; const first = controls[0], last = controls.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); } }
    }}>
      <header><div className="settings-icon"><SlidersHorizontal size={17} /></div><span><strong id="settings-title">{t("Settings")}</strong><small>{t("Read and save the project .env configuration")}</small></span><button type="button" title={t("Close settings")} aria-label={t("Close settings")} disabled={saving} onClick={onClose}><X size={16} /></button></header>
      <div className="config-source"><code title={initial.envPath}>{initial.envPath}</code><span>{t("Model changes apply to new sessions. Port and workspace changes require a server restart.")}</span></div>
      <div className="config-tabs" role="tablist" aria-label={t("Configuration modules")}>{initial.modules.map((item, index) => <button type="button" key={item.id} id={`config-tab-${item.id}`} role="tab" aria-selected={module === item.id} aria-controls={`config-panel-${item.id}`} tabIndex={module === item.id ? 0 : -1} onClick={() => setModule(item.id)} onKeyDown={(event) => {
        if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? initial.modules.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + initial.modules.length) % initial.modules.length; setModule(initial.modules[next]!.id); dialog.current?.querySelector<HTMLButtonElement>(`#config-tab-${initial.modules[next]!.id}`)?.focus(); }
      }}>{t(item.title)}</button>)}</div>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="config-form" role="tabpanel" id={`config-panel-${module}`} aria-labelledby={`config-tab-${module}`}><p className="config-module-description">{t(activeModule.description)}</p>
          {fields.map((field) => { const secret = field.type === "secret", value = (secret ? secrets[field.key] : values[field.key]) ?? "";
            const update = (next: string) => secret ? setSecrets((current) => ({ ...current, [field.key]: next })) : setValues((current) => ({ ...current, [field.key]: next }));
            return <label key={field.key}><span>{t(field.label)}{secret && <em>{initial.secretConfigured[field.key] ? t("Configured; leave blank to keep") : t("Not configured separately")}</em>}{field.restartRequired && <em>{t("Restart required")}</em>}</span><code className="config-env-key">{field.key}</code>
              {field.options ? <select aria-label={t(field.label)} value={value} disabled={saving} onChange={(event) => update(event.target.value)}>{(field.options.includes(value) ? field.options : [value, ...field.options]).map((option) => <option key={option} value={option}>{t(option) || t("Automatic / default")}</option>)}</select> : <input aria-label={t(field.label)} type={secret ? "password" : field.type === "number" ? "number" : "text"} value={value} disabled={saving} min={field.min} max={field.max} step={field.type === "number" ? 1 : undefined} placeholder={secret ? t("Leave blank to keep the current key") : field.example} autoComplete={secret ? "new-password" : "off"} onChange={(event) => update(event.target.value)} />}
              <small className="config-example">{t("Example:")} <code>{field.example}</code></small>{field.description && <small className="config-help">{t(field.description)}</small>}
            </label>;
          })}
        </div>
        {error && <p className="config-error" role="alert">{error}</p>}
        <footer><button type="button" disabled={saving} onClick={onClose}>{t("Cancel")}</button><button type="submit" className="primary" disabled={saving}><Save size={14} />{saving ? t("Saving…") : t("Save configuration")}</button></footer>
      </form>
    </section>
  </div>;
}
