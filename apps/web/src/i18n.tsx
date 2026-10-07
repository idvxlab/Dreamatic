import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import en from "./translations.en.json";
import zh from "./translations.zh.json";
export type Language = "en" | "zh";
export function translate(text: string, language: Language): string {
  if (language === "en") return (en as Record<string, string>)[text] ?? text;
  return (zh as Record<string, string>)[text] ?? text;
}
function initialLanguage(): Language {
  try { const saved = localStorage.getItem("dreamatic-ui-language"); if (saved === "en" || saved === "zh") return saved; } catch { /* Storage can be unavailable. */ }
  return navigator.language.startsWith("zh") ? "zh" : "en";
}
const Locale = createContext({ language: "en" as Language, setLanguage: (_: Language) => {}, t: (text: string) => text });
export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(initialLanguage);
  useEffect(() => { document.documentElement.lang = language === "zh" ? "zh-CN" : "en"; try { localStorage.setItem("dreamatic-ui-language", language); } catch { /* Still switch in memory. */ } }, [language]);
  return <Locale.Provider value={{ language, setLanguage, t: text => translate(text, language) }}>{children}</Locale.Provider>;
}
export const useI18n = () => useContext(Locale);
export function LanguageToggle() {
  const { language, setLanguage } = useI18n();
  return <div className="language-toggle" role="group" aria-label={language === "zh" ? "界面语言" : "Interface language"}>
    <button type="button" aria-pressed={language === "zh"} onClick={() => setLanguage("zh")}>中文</button>
    <button type="button" aria-pressed={language === "en"} onClick={() => setLanguage("en")}>EN</button>
  </div>;
}
