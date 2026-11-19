'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_LOCALE, LOCALE_COOKIE, LOCALE_NAMES, LOCALES, formatDate, formatDateTime, translate,
  type Locale, type MessageKey, type Params,
} from '@modulyn/i18n';

/**
 * Язык интерфейса (Phase 10, I2): начальное значение — из cookie (сервер отрисовал страницу на нём),
 * после входа — язык аккаунта из /api/auth/me. Переключатель меняет язык сразу, без перезагрузки.
 */

/** Текущий язык для кода вне React (клиент API): обновляется провайдером. */
let clientLocale: Locale = DEFAULT_LOCALE;
export function clientT(key: MessageKey, params?: Params): string {
  return translate(clientLocale, key, params);
}
/** Синхронно при отрисовке провайдера: эффекты дочерних компонентов (первые запросы) уже видят нужный язык. */
function syncClientLocale(locale: Locale): void {
  clientLocale = locale;
}

function writeCookie(locale: Locale): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

interface I18n {
  locale: Locale;
  t: (key: MessageKey, params?: Params) => string;
  dateTime: (value: string | Date) => string;
  date: (value: string | Date) => string;
  /** Сменить язык: cookie и страница — всегда; persist — ещё и в аккаунте (для вошедшего человека). */
  setLocale: (locale: Locale, options?: { persist?: boolean }) => void;
}

const Context = createContext<I18n | null>(null);

export function I18nProvider({ initial, children }: { initial: Locale; children: ReactNode }) {
  const [locale, setState] = useState<Locale>(initial);
  syncClientLocale(locale);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const setLocale = useCallback((next: Locale, options?: { persist?: boolean }) => {
    syncClientLocale(next);
    setState(next);
    writeCookie(next);
    if (options?.persist) {
      // Сохранение в аккаунте не критично для текущей страницы: ошибка не мешает работе (язык уже сменился).
      void fetch('/api/auth/locale', {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ locale: next }),
      }).catch(() => undefined);
    }
  }, []);

  const value = useMemo<I18n>(() => ({
    locale,
    t: (key, params) => translate(locale, key, params),
    dateTime: v => formatDateTime(locale, v),
    date: v => formatDate(locale, v),
    setLocale,
  }), [locale, setLocale]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(Context);
  if (!value) throw new Error('I18nProvider is missing');
  return value;
}

/** После загрузки аккаунта: его язык главнее cookie (I2). Cookie обновляется, чтобы следующая страница сразу была на нём. */
export function useAccountLocale(accountLocale: Locale | undefined): void {
  const { locale, setLocale } = useI18n();
  useEffect(() => {
    if (accountLocale && accountLocale !== locale) setLocale(accountLocale);
    // Только при загрузке аккаунта: дальше язык меняет переключатель.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountLocale]);
}

/** Переключатель DE · EN · RU. signedIn — выбор сохраняется и в аккаунте. */
export function LanguageSwitcher({ signedIn = false, className = '' }: { signedIn?: boolean; className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="group" aria-label={t('common.language')} className={`inline-flex rounded-md border border-slate-300 bg-white text-xs ${className}`}>
      {LOCALES.map(l => (
        <button key={l} type="button" lang={l} title={LOCALE_NAMES[l]} aria-pressed={l === locale}
          onClick={() => { if (l !== locale) setLocale(l, { persist: signedIn }); }}
          className={`px-2 py-1 font-medium uppercase first:rounded-l-md last:rounded-r-md ${l === locale ? 'bg-teal-800 text-white' : 'text-slate-700 hover:bg-slate-50'}`}>
          {l}
        </button>
      ))}
    </div>
  );
}
