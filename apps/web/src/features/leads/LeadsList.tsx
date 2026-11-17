'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LeadAssignee, LeadListResponse, LeadStatus } from '@modulyn/contracts';
import { Notice } from '../../components/ui';
import { ApiError, api } from '../auth/api';
import { LEAD_STATUS_LABEL } from './LeadsSummary';

export const STATUS_STYLE: Record<LeadStatus, string> = {
  NEW: 'bg-sky-50 text-sky-800', IN_PROGRESS: 'bg-amber-50 text-amber-800', CONTACTED: 'bg-violet-50 text-violet-800',
  CONVERTED: 'bg-teal-50 text-teal-800', CLOSED: 'bg-slate-100 text-slate-600',
};
const STATUSES = Object.keys(LEAD_STATUS_LABEL) as LeadStatus[];

/** Статус одной заявки (в сводке и фильтрах — множественное число: «Новые», здесь — «Новая»). */
export const LEAD_STATUS_ONE: Record<LeadStatus, string> = {
  NEW: 'Новая', IN_PROGRESS: 'В работе', CONTACTED: 'Связались', CONVERTED: 'Клиент', CLOSED: 'Закрыта',
};

export function StatusBadge({ status }: { status: LeadStatus }) {
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{LEAD_STATUS_ONE[status]}</span>;
}

export function sourceLabel(source: string, detail: string | null): string {
  const base = source === 'WEB_FORM' ? 'Сайт' : 'Вручную';
  return detail ? `${base} · ${detail}` : base;
}

/** Состояние списка живёт в адресе страницы (L2): ссылку с фильтрами можно отправить коллеге. */
export type LeadsQuery = Record<string, string | undefined>;

function buildQuery(q: LeadsQuery): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) params.set(k, v);
  return params.toString();
}

/** Список заявок (7.5): фильтры, поиск, сортировка, страницы; на телефоне — карточки вместо таблицы. */
export function LeadsList({ query }: { query: LeadsQuery }) {
  const router = useRouter();
  const [data, setData] = useState<LeadListResponse | null>(null);
  const [assignees, setAssignees] = useState<LeadAssignee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(query.q ?? '');
  const qs = buildQuery(query);

  useEffect(() => {
    let cancelled = false;
    api<LeadListResponse>('/api/leads' + (qs ? `?${qs}` : '')).then(d => { if (!cancelled) { setData(d); setError(null); } }, e => {
      if (!cancelled) setError(e instanceof ApiError && e.status === 403 ? 'Раздел «Заявки» отключён для вашей компании.' : e instanceof ApiError ? e.message : 'Не удалось загрузить заявки');
    });
    return () => { cancelled = true; };
  }, [qs]);

  useEffect(() => { api<LeadAssignee[]>('/api/leads/assignees').then(setAssignees, () => undefined); }, []);

  /** Новое состояние фильтров → новый адрес; при смене фильтра — первая страница. */
  function go(changes: LeadsQuery, keepPage = false) {
    const next = { ...query, ...changes, ...(keepPage ? {} : { page: undefined }) };
    const s = buildQuery(next);
    router.push('/leads' + (s ? `?${s}` : ''));
  }

  const selected = new Set((query.status ?? '').split(',').filter(Boolean));
  function toggleStatus(s: LeadStatus) {
    if (selected.has(s)) selected.delete(s); else selected.add(s);
    go({ status: [...selected].join(',') || undefined });
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    go({ q: search.trim() || undefined });
  }

  const page = Number(query.page ?? '1');
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered = Boolean(query.status || query.assignee || query.q);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Заявки</h1>
        <Link href="/leads/new" className="rounded-md bg-teal-800 px-4 py-2 text-sm font-medium text-white hover:bg-teal-900">Новая заявка</Link>
      </div>

      <div className="mb-4 space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Фильтр по статусу">
          {STATUSES.map(s => (
            <button key={s} type="button" aria-pressed={selected.has(s)} onClick={() => toggleStatus(s)}
              className={`rounded-full border px-3 py-1 text-sm ${selected.has(s) ? 'border-teal-800 bg-teal-800 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {LEAD_STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <form onSubmit={submitSearch} className="flex gap-2">
            <input aria-label="Поиск" placeholder="Имя, email или телефон" value={search} maxLength={100} onChange={e => setSearch(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">Найти</button>
          </form>
          <select aria-label="Ответственный" value={query.assignee ?? ''} onChange={e => go({ assignee: e.target.value || undefined })}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">Все ответственные</option>
            <option value="me">Мои</option>
            <option value="none">Без ответственного</option>
            {assignees.map(a => <option key={a.userId} value={a.userId}>{a.name}</option>)}
          </select>
          <select aria-label="Сортировка" value={query.sort ?? 'created_desc'} onChange={e => go({ sort: e.target.value === 'created_desc' ? undefined : e.target.value })}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="created_desc">Сначала новые</option>
            <option value="created_asc">Сначала старые</option>
          </select>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}
      {!error && !data && <p className="text-sm text-slate-500">Загрузка…</p>}
      {data && data.items.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">
          {filtered ? 'По этим условиям заявок нет.' : 'Заявок пока нет. Они появятся здесь, когда придут с сайта или будут добавлены вручную.'}
        </p>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white sm:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-3">Имя</th><th className="px-4 py-3">Контакт</th><th className="px-4 py-3">Источник</th><th className="px-4 py-3">Статус</th><th className="px-4 py-3">Ответственный</th><th className="px-4 py-3">Дата</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map(l => (
                  <tr key={l.id} className="cursor-pointer hover:bg-slate-50" onClick={() => router.push(`/leads/${l.id}`)}>
                    <td className="px-4 py-3 font-medium"><Link href={`/leads/${l.id}`} onClick={e => e.stopPropagation()} className="hover:text-teal-800">{l.name}</Link></td>
                    <td className="px-4 py-3 text-slate-600">{l.email ?? l.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{sourceLabel(l.source, l.sourceDetail)}</td>
                    <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                    <td className="px-4 py-3 text-slate-600">{l.assignee?.name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{new Date(l.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-3 sm:hidden">
            {data.items.map(l => (
              <li key={l.id}>
                <Link href={`/leads/${l.id}`} className="block rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-2"><p className="font-medium">{l.name}</p><StatusBadge status={l.status} /></div>
                  <p className="mt-1 text-sm text-slate-600">{l.email ?? l.phone ?? '—'}</p>
                  <p className="mt-1 text-xs text-slate-500">{sourceLabel(l.source, l.sourceDetail)} · {new Date(l.createdAt).toLocaleDateString('ru-RU')}{l.assignee ? ` · ${l.assignee.name}` : ''}</p>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between text-sm text-slate-600">
            <span>Всего: {data.total}</span>
            <div className="flex items-center gap-2">
              <button type="button" disabled={page <= 1} onClick={() => go({ page: String(page - 1) }, true)} className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40">Назад</button>
              <span>стр. {page} из {pages}</span>
              <button type="button" disabled={page >= pages} onClick={() => go({ page: String(page + 1) }, true)} className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40">Вперёд</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
