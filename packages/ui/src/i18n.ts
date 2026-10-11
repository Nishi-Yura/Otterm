/**
 * UI strings and Kotsume's lines through Fluent (decision C7). Messages live in
 * packages/ui/locales/<lang>.ftl; code refers to them by id only.
 */
import { FluentBundle, FluentResource, type FluentVariable } from "@fluent/bundle";
import { createSignal } from "solid-js";
import en from "../locales/en.ftl?raw";
import ja from "../locales/ja.ftl?raw";

export type Language = "ja" | "en";

const SOURCES: Record<Language, string> = { ja, en };
const bundles = new Map<Language, FluentBundle>();

function bundle(lang: Language): FluentBundle {
  let b = bundles.get(lang);
  if (!b) {
    // No bidi isolation marks: every UI language here is left-to-right, and the marks would show
    // up in copied text.
    b = new FluentBundle(lang, { useIsolating: false });
    b.addResource(new FluentResource(SOURCES[lang]));
    bundles.set(lang, b);
  }
  return b;
}

/** `auto` follows the OS (WebView) language: Japanese for `ja*`, English otherwise. */
export function resolveLanguage(setting: string): Language {
  if (setting === "ja" || setting === "en") return setting;
  return navigator.language.toLowerCase().startsWith("ja") ? "ja" : "en";
}

const [language, setLanguageSignal] = createSignal<Language>(resolveLanguage("auto"));

export { language };

export function setLanguage(setting: string): void {
  const lang = resolveLanguage(setting);
  document.documentElement.lang = lang;
  setLanguageSignal(lang);
}

/** An attribute of a message (`id.attr`), or `undefined` when there is none. */
export function tAttr(id: string, attr: string, args?: Record<string, FluentVariable>): string | undefined {
  for (const lang of [language(), "en"] as const) {
    const b = bundle(lang);
    const pattern = b.getMessage(id)?.attributes[attr];
    if (pattern) return b.formatPattern(pattern, args);
  }
  return undefined;
}

/** Whether there is a message `id`. */
export function hasMessage(id: string): boolean {
  return bundle(language()).hasMessage(id) || bundle("en").hasMessage(id);
}

/** The message `id` in the current language (English if it is missing there, else the id). */
export function t(id: string, args?: Record<string, FluentVariable>): string {
  for (const lang of [language(), "en"] as const) {
    const b = bundle(lang);
    const message = b.getMessage(id);
    if (message?.value) return b.formatPattern(message.value, args);
  }
  return id;
}
