'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { LeadAssignee, LeadDetail, LeadStatus, TenantRole } from '@modulyn/contracts';
import { Button, Notice } from '../../components/ui';
import { ApiError, api, post } from '../auth/api';
import { LEAD_STATUS_ONE as LEAD_STATUS_LABEL, StatusBadge, sourceLabel } from './LeadsList';

const STATUSES = Object.keys(LEAD_STATUS_LABEL) as LeadStatus[];
const time = (iso: string) => new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Карточка заявки (7.6): данные, смена статуса (обе роли), назначение (только администратор), история статусов.
 * При конфликте (заявку уже изменили, L3) карточка перезагружается и показывает актуальный статус.
 */
export function LeadCard({ id, role }: { id: string; role: TenantRole }) {
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [assignees, setAssignees] = useState<LeadAssignee[]>([]);
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(() => api<LeadDetail>(`/api/leads/${id}`).then(l => { setLead(l); setStatus(l.status); }, e => {
    if (e instanceof ApiError && e.status === 404) setMissing(true);
    else setMessage({ tone: 'error', text: e instanceof ApiError && e.status === 403 ? 'Раздел «Заявки» отключён для вашей компании.' : 'Не удалось загрузить заявку' });
  }), [id]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (role === 'TENANT_ADMIN') api<LeadAssignee[]>('/api/leads/assignees').then(setAssignees, () => undefined); }, [role]);

  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage({ tone: 'info', text: done }); }
    catch (e) { setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : 'Не удалось выполнить действие' }); }
    finally { setBusy(false); await load(); }
  }

  if (missing) {
    return <div><Notice>Заявка не найдена.</Notice><Link href="/leads" className="mt-4 inline-block text-sm text-teal-800">← Ко всем заявкам</Link></div>;
  }
  if (!lead) return message ? <Notice tone={message.tone}>{message.text}</Notice> : <p className="text-sm text-slate-500">Загрузка…</p>;

  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-6">
        <div>
          <Link href="/leads" className="text-sm text-teal-800 hover:underline">← Ко всем заявкам</Link>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{lead.name}</h1>
            <StatusBadge status={lead.status} />
          </div>
          <p className="mt-1 text-sm text-slate-500">{sourceLabel(lead.source, lead.sourceDetail)} · {time(lead.createdAt)}</p>
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <dl className="grid gap-4 rounded-lg border border-slate-200 bg-white p-5 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-500">Email</dt><dd className="mt-1">{lead.email ? <a href={`mailto:${lead.email}`} className="text-teal-800 hover:underline">{lead.email}</a> : '—'}</dd></div>
          <div><dt className="text-slate-500">Телефон</dt><dd className="mt-1">{lead.phone ? <a href={`tel:${lead.phone.replace(/\s/g, '')}`} className="text-teal-800 hover:underline">{lead.phone}</a> : '—'}</dd></div>
          <div className="sm:col-span-2"><dt className="text-slate-500">Сообщение</dt><dd className="mt-1 whitespace-pre-wrap">{lead.message ?? '—'}</dd></div>
        </dl>
        <section>
          <h2 className="mb-3 text-lg font-semibold">История</h2>
          <ol className="space-y-2 text-sm">
            {[...lead.history].reverse().map(h => (
              <li key={h.id} className="rounded-md border border-slate-200 bg-white px-4 py-3">
                <span className="text-slate-500">{time(h.createdAt)}</span>{' · '}
                {h.previousStatus ? <>{LEAD_STATUS_LABEL[h.previousStatus]} → <b>{LEAD_STATUS_LABEL[h.newStatus]}</b></> : <>Заявка создана</>}
                {' · '}<span className="text-slate-600">{h.changedBy?.name ?? (lead.source === 'WEB_FORM' ? 'с сайта' : 'система')}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <aside className="space-y-6">
        <div className="rounded-lg border border-slate-200 bg-white p-5">
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Статус</span>
            <select value={status} disabled={busy} onChange={e => setStatus(e.target.value as LeadStatus)} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2">
              {STATUSES.map(s => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}
            </select>
          </label>
          <div className="mt-3">
            <Button disabled={busy || status === lead.status} onClick={() => void act(
              () => post(`/api/leads/${id}/status`, { from: lead.status, to: status }), `Статус: ${LEAD_STATUS_LABEL[status as LeadStatus]}`)}>Сменить статус</Button>
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-5 text-sm">
          <p className="mb-1 font-medium">Ответственный</p>
          {role === 'TENANT_ADMIN' ? (
            <select aria-label="Ответственный" value={lead.assignee?.userId ?? ''} disabled={busy} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2"
              onChange={e => { const userId = e.target.value || null; void act(() => api(`/api/leads/${id}/assignee`, { method: 'PUT', body: JSON.stringify({ userId }) }), userId ? 'Ответственный назначен' : 'Назначение снято'); }}>
              <option value="">Не назначен</option>
              {assignees.map(a => <option key={a.userId} value={a.userId}>{a.name}</option>)}
            </select>
          ) : <p>{lead.assignee?.name ?? 'Не назначен'}</p>}
        </div>
      </aside>
    </div>
  );
}
