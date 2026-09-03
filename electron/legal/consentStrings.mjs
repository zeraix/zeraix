/**
 * The consent screen's text.
 *
 * A dictionary of its own rather than the renderer's locale files: the screen shows before the renderer, its
 * i18n and its saved language preference exist. It opens in English and offers Chinese from a switch on the
 * page — a fixed default rather than a guess from the OS locale, so every first launch looks the same and the
 * documents are agreed to in a language the user chose. `{link}` marks where the document's name goes in the
 * agreement line; it is a placeholder, not a suffix, because the object comes first in some grammars.
 */

/** The languages the page offers, in the order its switch lists them. */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
];

export const DEFAULT_LANGUAGE = "en";

export const STRINGS = {
  en: {
    title: "Welcome to Zeraix",
    intro: "Before you start, please read and agree to the Privacy Policy and the Terms of Service.",
    agreePrivacy: "I have read and agree to the {link}",
    privacy: "Privacy Policy",
    agreeTerms: "I have read and agree to the {link}",
    terms: "Terms of Service",
    accept: "Agree and continue",
    quit: "Quit",
    language: "Language",
  },
  zh: {
    title: "欢迎使用 Zeraix",
    intro: "开始使用前，请阅读并同意《隐私政策》和《服务条款》。",
    agreePrivacy: "我已阅读并同意{link}",
    privacy: "《隐私政策》",
    agreeTerms: "我已阅读并同意{link}",
    terms: "《服务条款》",
    accept: "同意并继续",
    quit: "退出",
    language: "语言",
  },
};

/** The screen's text for `code`; an unknown code gets the default language rather than blanks. */
export const stringsFor = (code) => STRINGS[code] ?? STRINGS[DEFAULT_LANGUAGE];
