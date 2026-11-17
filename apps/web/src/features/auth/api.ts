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

/** Нет ответа сервера (сеть, сервер не запущен): status 0. */
export const OFFLINE_MESSAGE = 'Нет связи с сервером. Проверьте подключение к интернету и попробуйте ещё раз.';

/** Запрос; сетевой сбой превращается в ApiError(0) с понятным текстом, а не в «TypeError: Failed to fetch». */
async function send(path: string, init: RequestInit): Promise<Response> {
  try { return await request(path, init); } catch { throw new ApiError(0, OFFLINE_MESSAGE); }
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
    let message = 'Не удалось выполнить запрос. Попробуйте ещё раз.';
    if (response.status === 401 && retry) message = 'Сеанс завершён. Обновите страницу, чтобы войти снова.';
    else if (response.status === 403) message = 'Недостаточно прав для этого действия.';
    else if (response.status >= 500) message = 'Сервис временно недоступен. Попробуйте через минуту — введённые данные не потеряны.';
    try {
      const body = await response.json() as { message?: string | string[]; code?: string };
      if (typeof body.message === 'string' && response.status !== 401 && response.status !== 403 && response.status < 500) message = body.message;
      if (response.status === 403 && body.code === 'MODULE_DISABLED') message = 'Раздел отключён для вашей компании. Обратитесь к администратору.';
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
