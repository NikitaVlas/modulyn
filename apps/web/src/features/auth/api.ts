'use client';

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

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(path: string, init: RequestInit): Promise<Response> {
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

/** JSON-запрос с автоматическим обновлением сессии. Бросает ApiError с сообщением для пользователя. */
export async function api<T>(path: string, init: RequestInit = {}, { retry = true } = {}): Promise<T> {
  let response = await request(path, init);
  if (response.status === 401 && retry && await refreshOnce()) response = await request(path, init);
  if (!response.ok) {
    let message = 'Не удалось выполнить запрос. Попробуйте ещё раз.';
    try {
      const body = await response.json() as { message?: string | string[] };
      if (typeof body.message === 'string' && response.status !== 401 && response.status !== 403 && response.status < 500) message = body.message;
    } catch { /* тело не JSON */ }
    throw new ApiError(response.status, message);
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
