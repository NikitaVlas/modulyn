'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { LeadAssignee, LeadDetail, LeadStatus, TenantRole } from '@modulyn/contracts';
import { Button, Notice } from '../../components/ui';
import { useI18n } from '../../i18n/client';
import { ApiError, api, post } from '../auth/api';
import { StatusBadge, sourceLabel } from './LeadsList';
import { LEAD_STATUSES } from './LeadsSummary';

/**
 * Карточка заявки (7.6): данные, смена статуса (обе роли), назначение (только администратор), история статусов.
 * При конфликте (заявку уже изменили, L3) карточка перезагружается и показывает актуальный статус.
 */
export function LeadCard({ id, role }: { id: string; role: TenantRole }) {
  const { t, dateTime } = useI18n();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [assignees, setAssignees] = useState<LeadAssignee[]>([]);
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [missing, setMissing] = useState(false);
  const router = useRouter();

  const load = useCallback(() => api<LeadDetail>(`/api/leads/${id}`).then(l => { setLead(l); setStatus(l.status); }, e => {
    if (e instanceof ApiError && e.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: t(e instanceof ApiError && e.status === 403 ? 'leads.disabled' : 'leads.loadOneFailed') });
  }), [id, t]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (role === 'TENANT_ADMIN') api<LeadAssignee[]>('/api/leads/assignees').then(setAssignees, () => undefined); }, [role]);

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage({ tone: 'info', text: done }); }
    catch (e) { setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : t('common.actionFailed') }); }
    finally { setBusy(false); await load(); }
  }

  /** Удаление (Phase 9, F6): только администратор; необратимо — вернуть можно лишь из резервной копии. */
  async function remove() {
    if (!lead || !window.confirm(t('leads.deleteConfirm', { name: lead.name }))) return;
    setBusy(true);
    setMessage(null);
    try {
      await api(`/api/leads/${id}`, { method: 'DELETE', body: '{}' });
      router.push('/leads?deleted=1');
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : t('leads.deleteFailed') });
      setBusy(false);
    }
  }

  if (missing) {
    return <div><Notice>{t('leads.notFound')}</Notice><Link href="/leads" className="mt-4 inline-block text-sm text-teal-800">{t('leads.backToAll')}</Link></div>;
  }
  if (!lead) return message ? <Notice tone={message.tone}>{message.text}</Notice> : <p className="text-sm text-slate-500">{t('common.loading')}</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-6">
        <div>
          <Link href="/leads" className="text-sm text-teal-800 hover:underline">{t('leads.backToAll')}</Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{lead.name}</h1>
            <StatusBadge status={lead.status} />
          </div>
          <p className="mt-1 text-sm text-slate-500">{sourceLabel(t, lead.source, lead.sourceDetail)} · {dateTime(lead.createdAt)}</p>
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <dl className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-500">{t('common.email')}</dt><dd className="mt-1">{lead.email ? <a href={`mailto:${lead.email}`} className="text-teal-800 hover:underline">{lead.email}</a> : '—'}</dd></div>
          <div><dt className="text-slate-500">{t('common.phone')}</dt><dd className="mt-1">{lead.phone ? <a href={`tel:${lead.phone.replace(/\s/g, '')}`} className="text-teal-800 hover:underline">{lead.phone}</a> : '—'}</dd></div>
          <div className="sm:col-span-2"><dt className="text-slate-500">{t('leads.message')}</dt><dd className="mt-1 whitespace-pre-wrap">{lead.message ?? '—'}</dd></div>
        </dl>
        <section>
          <h2 className="mb-3 text-lg font-semibold">{t('leads.history')}</h2>
          <ol className="space-y-2 text-sm">
            {[...lead.history].reverse().map(h => (
              <li key={h.id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
                <span className="text-slate-500">{dateTime(h.createdAt)}</span>{' · '}
                {h.previousStatus
                  ? <>{t(`leadStatus.${h.previousStatus}` as const)} → <b>{t(`leadStatus.${h.newStatus}` as const)}</b></>
                  : <>{t('leads.created')}</>}
                {' · '}<span className="text-slate-600">{h.changedBy?.name ?? t(lead.source === 'WEB_FORM' ? 'leads.byWebsite' : 'leads.bySystem')}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{t('leads.status')}</span>
            <select value={status} disabled={busy} onChange={e => setStatus(e.target.value as LeadStatus)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2">
              {LEAD_STATUSES.map(s => <option key={s} value={s}>{t(`leadStatus.${s}` as const)}</option>)}
            </select>
          </label>
          <div className="mt-3">
            <Button disabled={busy || status === lead.status} onClick={() => void act(
              () => post(`/api/leads/${id}/status`, { from: lead.status, to: status }),
              t('leads.statusChanged', { status: status ? t(`leadStatus.${status}` as const) : '' }))}>{t('leads.changeStatus')}</Button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm">
          <p className="mb-1 font-medium">{t('leads.assignee')}</p>
          {role === 'TENANT_ADMIN' ? (
            <select aria-label={t('leads.assignee')} value={lead.assignee?.userId ?? ''} disabled={busy} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2"
              onChange={e => { const userId = e.target.value || null; void act(() => api(`/api/leads/${id}/assignee`, { method: 'PUT', body: JSON.stringify({ userId }) }), t(userId ? 'leads.assignedDone' : 'leads.unassignedDone')); }}>
              <option value="">{t('leads.notAssigned')}</option>
              {assignees.map(a => <option key={a.userId} value={a.userId}>{a.name}</option>)}
            </select>
          ) : <p>{lead.assignee?.name ?? t('leads.notAssigned')}</p>}
        </div>
        {role === 'TENANT_ADMIN' && (
          <div className="rounded-lg border border-red-200 bg-white p-5 text-sm">
            <p className="font-medium">{t('leads.deleteTitle')}</p>
            <p className="mt-1 text-slate-600">{t('leads.deleteText')}</p>
            <button disabled={busy} onClick={() => void remove()} className="mt-3 w-full rounded-md border border-red-300 px-4 py-2 font-medium text-red-700 hover:bg-red-50">{t('leads.deleteTitle')}</button>
          </div>
        )}
      </aside>
    </div>
  );
}
