import { createHash } from 'node:crypto';

/**
 * Сопоставление и проверка полей формы сайта (Phase 8, W4, W5). Чистые функции без ввода-вывода.
 *
 * Стандартные имена понимаются без настройки: name или firstName + lastName, email, phone, message.
 * Точка приёма может переименовать поля (fields) и перечислить дополнительные поля (extra), которые
 * добавляются в текст сообщения строками «Подпись: значение». Остальные поля игнорируются.
 */
export const TARGET_FIELDS = ['name', 'firstName', 'lastName', 'email', 'phone', 'message'] as const;
export type TargetField = (typeof TARGET_FIELDS)[number];

export interface FieldMapping {
  fields?: Partial<Record<TargetField, string>>;
  extra?: { field: string; label: string }[];
}

export interface MappedLead { name: string; email: string | null; phone: string | null; message: string | null }

export type MapResult = { ok: true; lead: MappedLead } | { ok: false; field: string; reason: string };

const FIELD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const PHONE = /^[0-9+()\-\s./]{3,50}$/;

/** Проверка настройки сопоставления от администратора. null — ошибок нет. */
export function mappingError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'Некорректное сопоставление полей';
  const m = value as Record<string, unknown>;
  if (Object.keys(m).some(k => k !== 'fields' && k !== 'extra')) return 'Некорректное сопоставление полей';
  if (m.fields !== undefined) {
    if (typeof m.fields !== 'object' || m.fields === null || Array.isArray(m.fields)) return 'Некорректные переименования полей';
    for (const [target, source] of Object.entries(m.fields)) {
      if (!(TARGET_FIELDS as readonly string[]).includes(target)) return `Неизвестное поле заявки: ${target}`;
      if (typeof source !== 'string' || !FIELD_NAME.test(source)) return `Некорректное имя поля формы для «${target}»`;
    }
  }
  if (m.extra !== undefined) {
    if (!Array.isArray(m.extra) || m.extra.length > 20) return 'Дополнительных полей — не больше 20';
    for (const e of m.extra) {
      if (typeof e !== 'object' || e === null) return 'Некорректное дополнительное поле';
      const { field, label } = e as Record<string, unknown>;
      if (typeof field !== 'string' || !FIELD_NAME.test(field)) return 'Некорректное имя дополнительного поля';
      if (typeof label !== 'string' || label.trim().length === 0 || label.length > 50) return 'Подпись дополнительного поля — от 1 до 50 символов';
    }
  }
  return null;
}

function text(body: Record<string, unknown>, field: string | undefined, max: number): string | null | 'too-long' {
  if (!field) return null;
  const value = body[field];
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? 'too-long' : trimmed;
}

/** Тело формы → данные заявки. Те же правила, что у ручной заявки (L4): имя и хотя бы один контакт. */
export function mapSubmission(body: Record<string, unknown>, mapping: FieldMapping | null): MapResult {
  const f = { ...Object.fromEntries(TARGET_FIELDS.map(t => [t, t])), ...(mapping?.fields ?? {}) } as Record<TargetField, string>;
  const values: Partial<Record<TargetField, string | null>> = {};
  const limits: Record<TargetField, number> = { name: 200, firstName: 100, lastName: 100, email: 320, phone: 50, message: 5000 };
  for (const t of TARGET_FIELDS) {
    const v = text(body, f[t], limits[t]);
    if (v === 'too-long') return { ok: false, field: f[t], reason: 'too_long' };
    values[t] = v;
  }
  const name = values.name ?? [values.firstName, values.lastName].filter(Boolean).join(' ');
  if (!name) return { ok: false, field: f.name, reason: 'required' };
  if (name.length > 200) return { ok: false, field: f.name, reason: 'too_long' };
  const email = values.email?.toLowerCase() ?? null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, field: f.email, reason: 'invalid' };
  const phone = values.phone ?? null;
  if (phone && !PHONE.test(phone)) return { ok: false, field: f.phone, reason: 'invalid' };
  if (!email && !phone) return { ok: false, field: f.email, reason: 'contact_required' };

  const lines: string[] = [];
  for (const e of mapping?.extra ?? []) {
    const v = text(body, e.field, 500);
    if (v === 'too-long') return { ok: false, field: e.field, reason: 'too_long' };
    if (v) lines.push(`${e.label.trim()}: ${v}`);
  }
  if (values.message) lines.push(values.message);
  const message = lines.length > 0 ? lines.join('\n') : null;
  if (message && message.length > 5000) return { ok: false, field: f.message, reason: 'too_long' };
  return { ok: true, lead: { name, email, phone, message } };
}

/**
 * Ключ повтора (W3): переданный сайтом (Idempotency-Key или submissionId) или хеш содержимого заявки за сутки (UTC).
 * Ключ сайта отделён префиксом, чтобы не совпасть с хешем.
 */
export function idempotencyKey(provided: string | null, lead: MappedLead, now = new Date()): string {
  if (provided) return `id:${provided}`;
  const day = now.toISOString().slice(0, 10);
  const digest = createHash('sha256').update(JSON.stringify([lead.name, lead.email, lead.phone, lead.message, day])).digest('hex');
  return `h:${digest}`;
}

export const PROVIDED_KEY = /^[A-Za-z0-9_-]{8,128}$/;
