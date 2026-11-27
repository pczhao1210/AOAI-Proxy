import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";

const STORAGE_KEY = "aoai-admin-ui-lang";
const loaders = {
  en: () => import("./i18n/en.json").then(module => module.default),
  "zh-CN": () => import("./i18n/zh-CN.json").then(module => module.default)
};
function preferredLanguage() {
  const stored = typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null;
  return stored && loaders[stored] ? stored
    : typeof navigator !== "undefined" && navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}
const initialLanguage = preferredLanguage();
const initialDictionary = await loaders[initialLanguage]();
const cache = { [initialLanguage]: initialDictionary };
const Context = createContext(null);

export function I18nProvider({ children }) {
  const [state, setState] = useState(() => {
    const language = preferredLanguage();
    return cache[language] ? { language, dictionary: cache[language] } : { language: initialLanguage, dictionary: initialDictionary };
  });
  const request = useRef(0);
  useEffect(() => {
    const language = preferredLanguage();
    if (language !== state.language) void setLanguage(language);
    return () => { request.current++; };
  }, []);
  async function setLanguage(language) {
    if (!loaders[language]) return;
    const id = ++request.current;
    try {
      const dictionary = await loaders[language]();
      cache[language] = dictionary;
      if (id !== request.current) return;
      window.localStorage.setItem(STORAGE_KEY, language);
      setState({ language, dictionary });
    } catch (error) {
      if (id === request.current) toast.error(error.message);
    }
  }
  const value = useMemo(() => ({
    language: state.language,
    languages: Object.keys(loaders),
    setLanguage,
    t(key, fallback = key, variables = null) {
      const text = state.dictionary[key] || fallback;
      return variables ? text.replace(/\{(\w+)\}/g, (_, name) => String(variables[name] ?? "")) : text;
    }
  }), [state]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n() {
  const context = useContext(Context);
  if (!context) throw new Error("useI18n must be used within I18nProvider");
  return context;
}
