/**
 * Localization.
 *
 * No user-facing string is written inline anywhere in the codebase — the whole
 * UI reads keys through `t()`. Korean is the default and complete; English is
 * the fallback chain. Adding a language means adding one file and registering it.
 */

import { ko } from './ko.js';
import { en } from './en.js';

export type LocaleId = 'ko' | 'en' | 'ja' | 'zh';

export interface LocaleBundle {
  id: LocaleId;
  nameKey: string;
  /** Native display name — deliberately not translated. */
  displayName: string;
  strings: Record<string, string>;
  /** Fallback chain when a key is missing. */
  fallback: LocaleId | null;
}

const BUNDLES = new Map<LocaleId, LocaleBundle>();

export function registerLocale(bundle: LocaleBundle): void {
  BUNDLES.set(bundle.id, bundle);
}

registerLocale({ id: 'ko', nameKey: 'locale.ko', displayName: '한국어', strings: ko, fallback: 'en' });
registerLocale({ id: 'en', nameKey: 'locale.en', displayName: 'English', strings: en, fallback: null });

/**
 * Languages the UI offers. Japanese and Chinese are listed as *planned* and are
 * intentionally absent from BUNDLES — the language picker shows them disabled
 * rather than pretending they exist. See docs/LOCALIZATION.md.
 */
export const PLANNED_LOCALES: { id: LocaleId; displayName: string }[] = [
  { id: 'ja', displayName: '日本語' },
  { id: 'zh', displayName: '中文' },
];

export const DEFAULT_LOCALE: LocaleId = 'ko';

let currentLocale: LocaleId = DEFAULT_LOCALE;

export function setLocale(id: LocaleId): boolean {
  if (!BUNDLES.has(id)) return false;
  currentLocale = id;
  return true;
}

export const getLocale = (): LocaleId => currentLocale;

export const availableLocales = (): LocaleBundle[] => Array.from(BUNDLES.values());

/** Missing keys, collected so a QA pass can find untranslated UI. */
const missingKeys = new Set<string>();
export const getMissingKeys = (): string[] => Array.from(missingKeys).sort();

/**
 * Translate `key`, interpolating `{name}` placeholders from `params`.
 * A missing key returns the key itself — visible in the UI on purpose, so a
 * gap is obvious during QA rather than silently rendering an empty label.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  let locale: LocaleId | null = currentLocale;
  let raw: string | undefined;

  while (locale) {
    const bundle: LocaleBundle | undefined = BUNDLES.get(locale);
    if (!bundle) break;
    raw = bundle.strings[key];
    if (raw !== undefined) break;
    locale = bundle.fallback;
  }

  if (raw === undefined) {
    missingKeys.add(key);
    return key;
  }
  if (!params) return raw;

  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name];
    return v === undefined ? match : String(v);
  });
}

/** Plural helper. Korean has no plural inflection, English does. */
export function tp(key: string, count: number, params?: Record<string, string | number>): string {
  const suffix = currentLocale === 'en' && count !== 1 ? '.plural' : '';
  const withSuffix = `${key}${suffix}`;
  const result = t(withSuffix, { ...params, count });
  return result === withSuffix ? t(key, { ...params, count }) : result;
}

/** Number formatting — thousands separators differ by locale. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(currentLocale === 'ko' ? 'ko-KR' : 'en-US').format(value);
}

/** Duration as m:ss, for match timers. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export { ko, en };
