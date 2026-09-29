import { Save, SlidersHorizontal, X } from "lucide-react";
import { useState } from "react";
import type { RuntimeConfig } from "../api";

interface SettingsModalProps {
  initial: RuntimeConfig;
  onClose: () => void;
  onSave: (config: RuntimeConfig & { textApiKey?: string; searchApiKey?: string; imageApiKey?: string }) => Promise<void>;
}

export function SettingsModal({ initial, onClose, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState(initial);
  const [textApiKey, setTextApiKey] = useState("");
  const [searchApiKey, setSearchApiKey] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const update = (field: keyof RuntimeConfig, value: string) => setDraft((current) => ({ ...current, [field]: value }));

  async function submit() {
    setSaving(true);
    try { await onSave({ ...draft, ...(textApiKey ? { textApiKey } : {}), ...(searchApiKey ? { searchApiKey } : {}), ...(imageApiKey ? { imageApiKey } : {}) }); }
    finally { setSaving(false); }
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
    <section className="settings-modal config-modal" role="dialog" aria-modal="true" aria-label="Dreamatic settings" onMouseDown={(event) => event.stopPropagation()}>
      <header><div className="settings-icon"><SlidersHorizontal size={17} /></div><span><strong>Agent configuration</strong><small>Saved locally and applied to newly created Web and CLI sessions.</small></span><button title="Close settings" onClick={onClose}><X size={16} /></button></header>
      <div className="config-form">
        <label><span>Profile name</span><input value={draft.activeProfile} onChange={(event) => update("activeProfile", event.target.value)} /></label>
        <div className="field-pair"><label><span>Provider name</span><input value={draft.providerName} onChange={(event) => update("providerName", event.target.value)} /></label><label><span>Provider protocol</span><select value={draft.providerType} onChange={(event) => update("providerType", event.target.value)}><option value="openai-compatible">OpenAI compatible</option><option value="openai-responses">OpenAI Responses</option></select></label></div>
        <label><span>Text API base URL</span><input value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
        <div className="field-pair"><label><span>Text model</span><input value={draft.model} onChange={(event) => update("model", event.target.value)} /></label><label><span>Replace text API key <em>{draft.textApiKeyConfigured ? "configured" : "missing"}</em></span><input type="password" value={textApiKey} placeholder="Leave blank to keep current" onChange={(event) => setTextApiKey(event.target.value)} /></label></div>
        <div className="field-pair"><label><span>Web search</span><select value={draft.searchProvider || "duckduckgo"} onChange={(event) => update("searchProvider", event.target.value === "duckduckgo" ? "" : event.target.value)}><option value="duckduckgo">DuckDuckGo — no key</option><option value="serper">Serper — Google results</option></select></label><label><span>Replace search API key <em>{draft.searchApiKeyConfigured ? "configured" : "optional"}</em></span><input type="password" value={searchApiKey} placeholder="Required only for Serper" onChange={(event) => setSearchApiKey(event.target.value)} /></label></div>
        <label><span>Image API base URL</span><input value={draft.imageBaseUrl} onChange={(event) => update("imageBaseUrl", event.target.value)} /></label>
        <div className="field-pair"><label><span>Image model</span><input value={draft.imageModel} onChange={(event) => update("imageModel", event.target.value)} /></label><label><span>Default image size</span><select value={draft.imageDefaultSize} onChange={(event) => update("imageDefaultSize", event.target.value)}><option value="1024x1024">1024 × 1024</option><option value="1536x1024">1536 × 1024</option><option value="1024x1536">1024 × 1536</option></select></label></div>
        <details><summary>Image endpoints, response format, and key</summary><label><span>Generation endpoint</span><input value={draft.imageGenerationEndpoint} onChange={(event) => update("imageGenerationEndpoint", event.target.value)} /></label><label><span>Edit endpoint</span><input value={draft.imageEditEndpoint} onChange={(event) => update("imageEditEndpoint", event.target.value)} /></label><label><span>Response format</span><select value={draft.imageResponseFormat || "b64_json"} onChange={(event) => update("imageResponseFormat", event.target.value)}><option value="url">URL — recommended for proxy providers</option><option value="b64_json">Base64 JSON</option></select></label><label><span>Replace image API key <em>{draft.imageApiKeyConfigured ? "configured" : "missing"}</em></span><input type="password" value={imageApiKey} placeholder="Leave blank to keep current" onChange={(event) => setImageApiKey(event.target.value)} /></label></details>
      </div>
      <footer><button onClick={onClose}>Cancel</button><button className="primary" onClick={() => void submit()} disabled={saving}><Save size={14} /> {saving ? "Saving…" : "Save configuration"}</button></footer>
    </section>
  </div>;
}
