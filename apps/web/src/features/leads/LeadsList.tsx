'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LeadAssignee, LeadListResponse, LeadStatus } from '@modulyn/contracts';
import type { MessageKey, Params } from '@modulyn/i18n';
import { Notice } from '../../components/ui';
import { useI18n } from '../../i18n/client';
import { ApiError, api } from '../auth/api';
import { LEAD_STATUSES } from './LeadsSummary';

export const STATUS_STYLE: Record<LeadStatus, string> = {
  NEW: 'bg-sky-50 text-sky-800', IN_PROGRESS: 'bg-amber-50 text-amber-800', CONTACTED: 'bg-violet-50 text-violet-800',
  CONVERTED: 'bg-teal-50 text-teal-800', CLOSED: 'bg-slate-100 text-slate-600',
};

/** Статус одной заявки (в сводке и фильтрах — множественное число, здесь — единственное). */
export function StatusBadge({ status }: { status: LeadStatus }) {
  const { t } = useI18n();
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{t(`leadStatus.${status}` as const)}</span>;
}

type T = (key: MessageKey, params?: Params) => string;
export function sourceLabel(t: T, source: 'WEB_FORM' | 'MANUAL', detail: string | null): string {
  const base = t(`source.${source}` as const);
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
  const { t, date, dateTime } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<LeadListResponse | null>(null);
  const [assignees, setAssignees] = useState<LeadAssignee[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState(query.q ?? '');
  const qs = buildQuery(query);

  useEffect(() => {
    let cancelled = false;
    api<LeadListResponse>('/api/leads' + (qs ? `?${qs}` : '')).then(d => { if (!cancelled) { setData(d); setError(null); } }, e => {
      if (!cancelled) setError(e instanceof ApiError && e.status === 403 ? t('leads.disabled') : e instanceof ApiError ? e.message : t('leads.loadFailed'));
    });
    return () => { cancelled = true; };
  }, [qs, t]);

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
        <h1 className="text-2xl font-semibold tracking-tight">{t('leads.title')}</h1>
        <Link href="/leads/new" className="rounded-md bg-teal-800 px-4 py-2 text-sm font-medium text-white hover:bg-teal-900">{t('leads.new')}</Link>
      </div>

      <div className="mb-4 space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('leads.statusFilter')}>
          {LEAD_STATUSES.map(s => (
            <button key={s} type="button" aria-pressed={selected.has(s)} onClick={() => toggleStatus(s)}
              className={`rounded-full border px-3 py-1 text-sm ${selected.has(s) ? 'border-teal-800 bg-teal-800 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {t(`leadStatuses.${s}` as const)}
            </button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <form onSubmit={submitSearch} className="flex gap-2">
            <input aria-label={t('leads.search')} placeholder={t('leads.searchPlaceholder')} value={search} maxLength={100} onChange={e => setSearch(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            <button type="submit" className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">{t('leads.find')}</button>
          </form>
          <select aria-label={t('leads.assignee')} value={query.assignee ?? ''} onChange={e => go({ assignee: e.target.value || undefined })}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="">{t('leads.allAssignees')}</option>
            <option value="me">{t('leads.mine')}</option>
            <option value="none">{t('leads.unassigned')}</option>
            {assignees.map(a => <option key={a.userId} value={a.userId}>{a.name}</option>)}
          </select>
          <select aria-label={t('leads.sort')} value={query.sort ?? 'created_desc'} onChange={e => go({ sort: e.target.value === 'created_desc' ? undefined : e.target.value })}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm">
            <option value="created_desc">{t('leads.newestFirst')}</option>
            <option value="created_asc">{t('leads.oldestFirst')}</option>
          </select>
        </div>
      </div>

      {error && <Notice>{error}</Notice>}
      {!error && !data && <p className="text-sm text-slate-500">{t('common.loading')}</p>}
      {data && data.items.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-600">
          {filtered ? t('leads.noneFiltered') : t('leads.empty')}
        </p>
      )}

      {data && data.items.length > 0 && (
        <>
          <div className="hidden overflow-hidden rounded-lg border border-slate-200 bg-white sm:block">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('common.name')}</th><th className="px-4 py-3">{t('leads.col.contact')}</th><th className="px-4 py-3">{t('leads.col.source')}</th>
                  <th className="px-4 py-3">{t('leads.col.status')}</th><th className="px-4 py-3">{t('leads.assignee')}</th><th className="px-4 py-3">{t('leads.col.date')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.items.map(l => (
                  <tr key={l.id} className="cursor-pointer hover:bg-slate-50" onClick={() => router.push(`/leads/${l.id}`)}>
                    <td className="px-4 py-3 font-medium"><Link href={`/leads/${l.id}`} onClick={e => e.stopPropagation()} className="hover:text-teal-800">{l.name}</Link></td>
                    <td className="px-4 py-3 text-slate-600">{l.email ?? l.phone ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-600">{sourceLabel(t, l.source, l.sourceDetail)}</td>
                    <td className="px-4 py-3"><StatusBadge status={l.status} /></td>
                    <td className="px-4 py-3 text-slate-600">{l.assignee?.name ?? '—'}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{dateTime(l.createdAt)}</td>
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
                  <p className="mt-1 text-xs text-slate-500">{sourceLabel(t, l.source, l.sourceDetail)} · {date(l.createdAt)}{l.assignee ? ` · ${l.assignee.name}` : ''}</p>
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
            <span>{t('leads.totalShort', { count: data.total })}</span>
            <div className="flex items-center gap-2">
              <button type="button" disabled={page <= 1} onClick={() => go({ page: String(page - 1) }, true)} className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40">{t('common.back')}</button>
              <span>{t('leads.page', { page, pages })}</span>
              <button type="button" disabled={page >= pages} onClick={() => go({ page: String(page + 1) }, true)} className="rounded-md border border-slate-300 px-3 py-1 disabled:opacity-40">{t('common.forward')}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
