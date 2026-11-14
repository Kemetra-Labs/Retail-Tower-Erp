import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { format, type Lang, type StringKey, type Vars } from "./strings";

export type LangApi = {
  lang: Lang;
  /** One fixed string in the current language; `{n}`-style holes are filled from `vars`. */
  t: (key: StringKey, vars?: Vars) => string;
  setLang: (lang: Lang) => void;
};

const LangContext = createContext<LangApi | null>(null);

/** Keeps `<html lang dir>` in step with the language (Arabic reads right to left). */
export function LangProvider({ children, initial = "en" }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLangState] = useState<Lang>(initial);

  useEffect(() => {
    const root = document.documentElement;
    root.lang = lang;
    root.dir = lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  const t = useCallback((key: StringKey, vars?: Vars) => format(key, lang, vars), [lang]);
  const api = useMemo<LangApi>(() => ({ lang, t, setLang: setLangState }), [lang, t]);
  return <LangContext.Provider value={api}>{children}</LangContext.Provider>;
}

export function useLang(): LangApi {
  const api = useContext(LangContext);
  if (!api) throw new Error("useLang needs a LangProvider above it");
  return api;
}
