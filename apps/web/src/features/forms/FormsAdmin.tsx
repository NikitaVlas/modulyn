'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  FormEndpointCreatedResponse, FormEndpointInfo, FormEndpointMode, FormFieldMapping, FormSecretResponse, FormSubmissionEntry, FormSubmissionStatus,
} from '@modulyn/contracts';
import { Button, Field, Notice } from '../../components/ui';
import { ApiError, api, post } from '../auth/api';

const MODE: Record<FormEndpointMode, string> = { SERVER: 'С сервера сайта', BROWSER: 'Из браузера' };
const STATUS: Record<FormSubmissionStatus, string> = { IMPORTED: 'Принята', DUPLICATE: 'Дубль', REJECTED: 'Отклонена' };
const REASON: Record<string, string> = {
  unauthorized: 'неверный секрет', origin_not_allowed: 'чужой сайт', invalid_json: 'не JSON', spam: 'бот (скрытое поле)',
  invalid_name: 'нет имени', invalid_email: 'email', invalid_phone: 'телефон', invalid_message: 'сообщение',
};

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Не удалось выполнить действие';
}
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** «program = Программа» по строке → extra; пустые строки пропускаются. */
function parseExtra(text: string): FormFieldMapping['extra'] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [field = '', ...label] = l.split('=');
    return { field: field.trim(), label: label.join('=').trim() || field.trim() };
  });
}
const extraText = (m: FormFieldMapping | null) => (m?.extra ?? []).map(e => `${e.field} = ${e.label}`).join('\n');

/**
 * Приём заявок с сайтов (8.9–8.11): точки приёма, секрет (показывается один раз), журнал без содержимого форм.
 * Права проверяет сервер (администратор компании, модуль «Заявки» включён).
 */
export function FormsAdmin() {
  const [endpoints, setEndpoints] = useState<FormEndpointInfo[] | null>(null);
  const [journal, setJournal] = useState<FormSubmissionEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [editing, setEditing] = useState<FormEndpointInfo | 'new' | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api<FormEndpointInfo[]>('/api/form-endpoints').then(setEndpoints, e => setMessage({ tone: 'error', text: errorText(e) }));
    api<FormSubmissionEntry[]>('/api/form-endpoints/submissions' + (filter ? `?endpointId=${encodeURIComponent(filter)}` : ''))
      .then(setJournal, () => setJournal([]));
  }, [filter]);
  useEffect(() => { reload(); }, [reload]);

  async function run(action: () => Promise<unknown>, done: string | null) {
    setBusy(true);
    setMessage(null);
    try { await action(); if (done) setMessage({ tone: 'info', text: done }); reload(); }
    catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  function toggle(e: FormEndpointInfo) {
    if (e.isActive && !window.confirm(`Отключить «${e.name}»? Сайт получит ошибку 404, заявки с него приниматься не будут.`)) return;
    void run(() => api(`/api/form-endpoints/${e.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !e.isActive }) }), e.isActive ? 'Точка отключена' : 'Точка включена');
  }

  function rotate(e: FormEndpointInfo) {
    if (!window.confirm(`Выпустить новый секрет для «${e.name}»? Старый перестанет работать сразу — его нужно будет заменить на сайте.`)) return;
    void run(async () => {
      const r = await post<FormSecretResponse>(`/api/form-endpoints/${e.id}/rotate-secret`);
      setSecret({ name: e.name, value: r.secret });
    }, null);
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Приём заявок с сайтов</h1>
        {editing === null && <div className="w-full sm:w-52"><Button onClick={() => { setEditing('new'); setSecret(null); }}>Новая точка приёма</Button></div>}
      </div>
      <p className="mb-6 max-w-3xl text-sm leading-6 text-slate-600">
        Точка приёма — адрес, на который сайт отправляет заявки. Каждая заявка появляется в разделе «Заявки» со статусом «Новая».
        Инструкция для разработчика сайта — в документации Modulyn (docs/integrations/web-forms.md).
      </p>
      {message && <div className="mb-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {secret && <SecretBox name={secret.name} value={secret.value} onClose={() => setSecret(null)} />}
      {editing !== null && (
        <EndpointForm endpoint={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSaved={(text, newSecret) => {
          setEditing(null);
          setMessage({ tone: 'info', text });
          if (newSecret) setSecret(newSecret);
          reload();
        }} />
      )}

      {!endpoints ? <p className="text-sm text-slate-500">Загрузка…</p> : endpoints.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-6 text-sm text-slate-500">Точек приёма пока нет.</p>
      ) : (
        <ul className="space-y-3">
          {endpoints.map(e => (
            <li key={e.id} className={`rounded-lg border border-slate-200 bg-white p-4 text-sm ${e.isActive ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{e.name} {!e.isActive && <span className="ml-1 text-xs text-slate-500">(отключена)</span>}</p>
                  <p className="text-xs text-slate-500">
                    {MODE[e.mode]}{e.sourceDetail && <> · тип {e.sourceDetail}</>} · последняя заявка: {dateTime(e.lastUsedAt)}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button disabled={busy} onClick={() => { setEditing(e); setSecret(null); }} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50">Изменить</button>
                  {e.mode === 'SERVER' && <button disabled={busy} onClick={() => rotate(e)} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50">Новый секрет</button>}
                  <button disabled={busy} onClick={() => toggle(e)} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50">{e.isActive ? 'Отключить' : 'Включить'}</button>
                </div>
              </div>
              <dl className="mt-3 grid gap-1 text-xs sm:grid-cols-[10rem_1fr]">
                <dt className="text-slate-500">Адрес приёма</dt>
                <dd className="flex min-w-0 items-center gap-2"><code className="truncate rounded bg-slate-100 px-1.5 py-0.5">{e.intakeUrl}</code><Copy text={e.intakeUrl} /></dd>
                {e.mode === 'SERVER' && <><dt className="text-slate-500">Секрет</dt><dd><code>{e.secretPrefix}…</code> <span className="text-slate-500">(полностью показывается только при создании)</span></dd></>}
                {e.mode === 'BROWSER' && <><dt className="text-slate-500">Разрешённые сайты</dt><dd>{e.allowedOrigins.join(', ')}</dd></>}
                {(e.fieldMapping?.extra?.length ?? 0) > 0 && <><dt className="text-slate-500">Доп. поля в сообщение</dt><dd>{e.fieldMapping?.extra?.map(x => `${x.label} (${x.field})`).join(', ')}</dd></>}
              </dl>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-10">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Журнал приёма</h2>
          <select aria-label="Точка приёма" value={filter} onChange={e => setFilter(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1 text-sm">
            <option value="">Все точки</option>
            {endpoints?.map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
          </select>
        </div>
        <p className="mb-3 text-xs text-slate-500">Последние 100 отправок. Содержимое форм в журнале не хранится — только результат.</p>
        {journal.length === 0 ? <p className="text-sm text-slate-500">Отправок пока не было.</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-2">Время</th><th className="px-4 py-2">Точка</th><th className="px-4 py-2">Результат</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {journal.map(s => (
                  <tr key={s.id}>
                    <td className="px-4 py-2 whitespace-nowrap">{dateTime(s.createdAt)}</td>
                    <td className="px-4 py-2">{s.endpointName}</td>
                    <td className={`px-4 py-2 ${s.status === 'REJECTED' ? 'text-red-700' : s.status === 'DUPLICATE' ? 'text-slate-500' : ''}`}>
                      {STATUS[s.status]}{s.errorCode && <span className="text-xs"> · {REASON[s.errorCode] ?? s.errorCode}</span>}
                    </td>
                    <td className="px-4 py-2 text-right">{s.leadId && <Link href={`/leads/${s.leadId}`} className="text-teal-800 hover:underline">Заявка</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="shrink-0 rounded border border-slate-300 px-2 py-0.5 hover:bg-slate-50"
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Скопировано' : 'Копировать'}
    </button>
  );
}

function SecretBox({ name, value, onClose }: { name: string; value: string; onClose: () => void }) {
  return (
    <div role="status" className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
      <p className="font-medium">Секрет для «{name}» — скопируйте сейчас</p>
      <p className="mt-1 text-amber-900">Он показывается один раз. В Modulyn хранится только его отпечаток: восстановить секрет нельзя, можно только выпустить новый.</p>
      <div className="mt-3 flex min-w-0 items-center gap-2"><code className="truncate rounded bg-white px-2 py-1">{value}</code><Copy text={value} /></div>
      <button onClick={onClose} className="mt-3 text-xs text-amber-900 underline">Я сохранил секрет — скрыть</button>
    </div>
  );
}

function EndpointForm({ endpoint, onCancel, onSaved }: {
  endpoint: FormEndpointInfo | null; onCancel: () => void;
  onSaved: (text: string, secret: { name: string; value: string } | null) => void;
}) {
  const [form, setForm] = useState({
    name: endpoint?.name ?? '', mode: endpoint?.mode ?? 'SERVER' as FormEndpointMode, sourceDetail: endpoint?.sourceDetail ?? '',
    origins: endpoint?.allowedOrigins.join('\n') ?? '', extra: extraText(endpoint?.fieldMapping ?? null),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const extra = parseExtra(form.extra) ?? [];
    const fieldMapping: FormFieldMapping | null = extra.length > 0 || endpoint?.fieldMapping?.fields
      ? { ...(endpoint?.fieldMapping?.fields ? { fields: endpoint.fieldMapping.fields } : {}), ...(extra.length > 0 ? { extra } : {}) }
      : null;
    const origins = form.origins.split('\n').map(s => s.trim()).filter(Boolean);
    const body = { name: form.name, sourceDetail: form.sourceDetail.trim() || null, fieldMapping, ...(form.mode === 'BROWSER' ? { allowedOrigins: origins } : {}) };
    try {
      if (endpoint) {
        await api(`/api/form-endpoints/${endpoint.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        onSaved('Изменения сохранены', null);
      } else {
        const r = await post<FormEndpointCreatedResponse>('/api/form-endpoints', { ...body, mode: form.mode });
        onSaved('Точка приёма создана', r.secret ? { name: r.endpoint.name, value: r.secret } : null);
      }
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  const area = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20';
  return (
    <form onSubmit={submit} className="mb-8 space-y-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">{endpoint ? `Изменить «${endpoint.name}»` : 'Новая точка приёма'}</h2>
      {error && <Notice>{error}</Notice>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Название" required maxLength={100} placeholder="Сайт, форма пробной тренировки" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        <Field label="Тип заявки (необязательно)" maxLength={50} placeholder="trial" value={form.sourceDetail} onChange={e => setForm({ ...form, sourceDetail: e.target.value })} />
      </div>
      {!endpoint && (
        <fieldset className="text-sm">
          <legend className="mb-1 font-medium text-slate-700">Как сайт отправляет заявки</legend>
          {(['SERVER', 'BROWSER'] as const).map(m => (
            <label key={m} className="mt-1 flex items-start gap-2">
              <input type="radio" name="mode" checked={form.mode === m} onChange={() => setForm({ ...form, mode: m })} className="mt-1" />
              <span>{MODE[m]} — <span className="text-slate-500">{m === 'SERVER'
                ? 'PHP, Node, WordPress-плагин: запрос с секретом (надёжнее, рекомендуется)'
                : 'статический сайт без сервера: JavaScript на странице, только с указанных адресов'}</span></span>
            </label>
          ))}
        </fieldset>
      )}
      {form.mode === 'BROWSER' && (
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Адреса сайта — по одному в строке</span>
          <textarea rows={2} className={area} placeholder="https://example.com" value={form.origins} onChange={e => setForm({ ...form, origins: e.target.value })} />
        </label>
      )}
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Дополнительные поля формы → в сообщение заявки</span>
        <span className="mb-1 block text-xs text-slate-500">По одному в строке: «поле = подпись», например «program = Программа». Имя, email, телефон и сообщение распознаются сами.</span>
        <textarea rows={2} className={area} value={form.extra} onChange={e => setForm({ ...form, extra: e.target.value })} />
      </label>
      <div className="flex gap-3">
        <div className="w-40"><Button type="submit" disabled={busy}>{busy ? 'Сохранение…' : endpoint ? 'Сохранить' : 'Создать'}</Button></div>
        <div className="w-32"><Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button></div>
      </div>
    </form>
  );
}
