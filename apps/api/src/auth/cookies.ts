import type { CookieOptions, Request, Response } from 'express';

/**
 * Cookies сессий (A3, A7).
 * Без атрибута Domain браузер отправляет cookie только на тот хост, где она создана: сессия nova.<домен>
 * физически не приходит на company-b.<домен>. С https имена получают префикс __Host-, который браузер принимает
 * только вместе с Secure, Path=/ и без Domain — то есть гарантирует эти свойства. Локально по http префикс невозможен.
 */
export type CookieName = 'access' | 'refresh' | 'handoffState' | 'oidcState' | 'mfaPending';

const BASE: Record<CookieName, string> = { access: 'mdl_at', refresh: 'mdl_rt', handoffState: 'mdl_hs', oidcState: 'mdl_oidc', mfaPending: 'mdl_mfa' };
const SAME_SITE: Record<CookieName, 'lax' | 'strict'> = {
  mfaPending: 'strict',   // второй шаг входа платформы — только со своей страницы
  access: 'lax',          // нужна при переходе по ссылке на поддомен
  refresh: 'strict',      // обновление — только запросом со своей страницы
  handoffState: 'lax',    // возвращается при переходе с app.<домен>
  oidcState: 'lax',       // возвращается при переходе с accounts.google.com
};

export function cookieName(name: CookieName, secure: boolean): string {
  return (secure ? '__Host-' : '') + BASE[name];
}

function options(name: CookieName, secure: boolean, maxAgeMs?: number): CookieOptions {
  return { httpOnly: true, secure, sameSite: SAME_SITE[name], path: '/', ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}) };
}

export function setCookie(res: Response, name: CookieName, value: string, secure: boolean, maxAgeMs: number): void {
  res.cookie(cookieName(name, secure), value, options(name, secure, maxAgeMs));
}

export function clearCookie(res: Response, name: CookieName, secure: boolean): void {
  res.clearCookie(cookieName(name, secure), options(name, secure));
}

/** Разбор заголовка Cookie без дополнительной зависимости. Повторяющееся имя — берётся первое. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  if (!header || header.length > 8192) return result;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    if (result.has(key)) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { result.set(key, decodeURIComponent(value)); } catch { /* повреждённое значение пропускаем */ }
  }
  return result;
}

export function readCookie(req: Request, name: CookieName, secure: boolean): string | undefined {
  return parseCookies(req.headers.cookie).get(cookieName(name, secure));
}
