"use client";

/**
 * Lightweight i18n (zero third-party dependencies): Multi-language UI copy with runtime switching.
 *
 * - Each language has its own JSON file (`src/locales/<code>.json`), aggregated here into the `DICT` map.
 * - Current language state is managed via Zustand (components subscribe using `useT()` and re-render on switch) and persisted to localStorage (`agent.locale`).
 * - Missing key fallback strategy: Current Language → English → Simplified Chinese → Key Name itself.
 */
import { create } from "zustand";
import { getStorage } from "@zzcpt/zztool";
import { AGENT_LOCALE_KEY } from "@/constants/Agent";
import { putStorage } from "@/lib/ai/agentStorage";
import { isCnEdition } from "./edition";

import zh from "@/locales/zh.json";
import zhTW from "@/locales/zh-TW.json";
import en from "@/locales/en.json";
import enGB from "@/locales/en-GB.json";
import ja from "@/locales/ja.json";
import ko from "@/locales/ko.json";
import de from "@/locales/de.json";
import fr from "@/locales/fr.json";
import es from "@/locales/es.json";
import it from "@/locales/it.json";
import pt from "@/locales/pt.json";

type Dict = Record<string, string>;

export type Locale =
  | "zh"
  | "zh-TW"
  | "en"
  | "en-GB"
  | "ja"
  | "ko"
  | "de"
  | "fr"
  | "es"
  | "it"
  | "pt";

const DICT: Record<Locale, Dict> = {
  zh,
  "zh-TW": zhTW,
  en,
  "en-GB": enGB,
  ja,
  ko,
  de,
  fr,
  es,
  it,
  pt,
};

/** List of available languages (for dropdown menus); labels use each language's endonym. */
export const LOCALES: { code: Locale; label: string }[] = [
  { code: "en", label: "English (US)" },
  { code: "en-GB", label: "English (UK)" },
  { code: "zh", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "pt", label: "Português" },
];

function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(DICT, v);
}

function readLocale(): Locale {
  const v = getStorage(AGENT_LOCALE_KEY);
  return isLocale(v) ? v : isCnEdition ? "zh" : "en"; // Default to zh for CN edition, en for others
}

interface LocaleState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: readLocale(), // Synchronously read upon client-side initialization to prevent initial screen flickering (SSR defaults to 'en')
  setLocale: (locale) => {
    putStorage(AGENT_LOCALE_KEY, locale);
    set({ locale });
  },
}));

/** Translation function type. Optional `vars` allow for `{name}` placeholder interpolation. */
export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** Subscribe to the current language and return a translation function `t(key, vars?)`. Missing keys fallback: Current Language → en → zh → Key Name; `vars` are used for `{name}` placeholder interpolation. */
export function useT(): TFunc {
  const locale = useLocaleStore((s) => s.locale);
  return (key: string, vars?: Record<string, string | number>) => {
    const s = DICT[locale]?.[key] ?? DICT.en[key] ?? DICT.zh[key] ?? key;
    return vars ? s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`)) : s;
  };
}

/**
 * Translation function for non-React contexts (reads the current language snapshot without subscribing). 
 * Used in event callbacks, utility functions, or other places where Hooks cannot be used.
 * The fallback chain is identical to `useT`: Current Language → en → zh → Key Name.
 */
export function translate(key: string): string {
  const locale = useLocaleStore.getState().locale;
  return DICT[locale]?.[key] ?? DICT.en[key] ?? DICT.zh[key] ?? key;
}

/** Translation with placeholder interpolation: {name} in the template is replaced by vars.name. */
export function translateWith(key: string, vars: Record<string, string | number>): string {
  return translate(key).replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}
