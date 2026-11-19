'use client';

import { clientT } from '../../i18n/client';

/**
 * Запросы к API того же хоста. Токены лежат в HttpOnly cookies, JavaScript их не видит и не передаёт сам.
 * При 401 выполняется одно обновление сессии (общее для параллельных запросов), затем запрос повторяется.
 * 409 от /refresh значит, что другая вкладка уже обновила токен: cookie новая, просто повторяем запрос.
 */
let refreshing: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  refreshing ??= (async () => {
    try {
      const r = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' });
      return r.ok || r.status === 409;
    } catch { return false; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })();
  return refreshing;
}

/** code — машинный код ошибки API, если есть (MODULE_DISABLED, LEAD_CHANGED, MFA_INVALID_CODE…). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

async function request(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** Запрос; сетевой сбой (status 0) превращается в ApiError с понятным текстом, а не в «TypeError: Failed to fetch». */
async function send(path: string, init: RequestInit): Promise<Response> {
  try { return await request(path, init); } catch { throw new ApiError(0, clientT('client.offline')); }
}

/**
 * JSON-запрос с автоматическим обновлением сессии. Бросает ApiError с сообщением для пользователя (Phase 9.3):
 * - 401 после неудачного обновления — сеанс завершён (выход в другой вкладке, отключение доступа, истёк срок);
 * - 5xx и 502/504 от прокси — сервис временно недоступен (введённые данные остаются в форме);
 * - 400/409/429 — сообщение сервера (оно написано для пользователя).
 */
export async function api<T>(path: string, init: RequestInit = {}, { retry = true } = {}): Promise<T> {
  let response = await send(path, init);
  if (response.status === 401 && retry && await refreshOnce()) response = await send(path, init);
  if (!response.ok) {
    // Сообщения API уже на языке пользователя (Phase 10, I5); общие случаи — из словаря интерфейса.
    let message = clientT('client.generic');
    let code: string | undefined;
    if (response.status === 401 && retry) message = clientT('client.sessionEnded');
    else if (response.status === 403) message = clientT('client.forbidden');
    else if (response.status >= 500) message = clientT('client.unavailable');
    try {
      const body = await response.json() as { message?: string | string[]; code?: string };
      code = typeof body.code === 'string' ? body.code : undefined;
      if (typeof body.message === 'string' && response.status !== 401 && response.status !== 403 && response.status < 500) message = body.message;
      if (response.status === 403 && code === 'MODULE_DISABLED') message = clientT('client.moduleDisabled');
    } catch { /* тело не JSON */ }
    throw new ApiError(response.status, message, code);
  }
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

export function post<T>(path: string, body: unknown = {}, options?: { retry?: boolean }): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) }, options);
}

/** Адрес другого поддомена с той же схемой и портом, что у текущей страницы. */
export function originOf(label: string, baseDomain: string): string {
  const { protocol, port } = window.location;
  return `${protocol}//${label}.${baseDomain}${port ? ':' + port : ''}`;
}
