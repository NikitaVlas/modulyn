'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { InvitationSentResponse, MemberEntry, MembersResponse, TenantRole } from '@modulyn/contracts';
import { Button, Field, Notice } from '../../components/ui';
import { useI18n } from '../../i18n/client';
import { ApiError, api, post } from '../auth/api';

/**
 * Пользователи компании (5.4): участники, ожидающие приглашения, приглашение, роль и доступ.
 * Права проверяет сервер (только администратор компании); здесь — удобный интерфейс к ним.
 */
export function MembersAdmin() {
  const { t, date } = useI18n();
  const [data, setData] = useState<MembersResponse | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const errorText = useCallback((e: unknown) => (e instanceof ApiError ? e.message : t('common.actionFailed')), [t]);

  const reload = useCallback(() => {
    api<MembersResponse>('/api/members').then(setData, e => setMessage({ tone: 'error', text: errorText(e) }));
  }, [errorText]);
  useEffect(() => { reload(); }, [reload]);

  async function run(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); setMessage({ tone: 'info', text: done }); reload(); }
    catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  const patch = (m: MemberEntry, body: Record<string, unknown>, done: string) =>
    run(() => api(`/api/members/${m.userId}`, { method: 'PATCH', body: JSON.stringify(body) }), done);

  function toggle(m: MemberEntry) {
    if (m.isActive && !window.confirm(t('members.disableConfirm', { name: m.name }))) return;
    void patch(m, { isActive: !m.isActive }, t(m.isActive ? 'members.accessDisabled' : 'members.accessEnabled'));
  }

  const roleLabel = (role: TenantRole) => t(`role.${role}` as const);

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{t('members.title')}</h1>
      {message && <div className="mb-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      <InviteForm onSent={(sent, email) => {
        setMessage(sent ? { tone: 'info', text: t('members.invited', { email }) } : { tone: 'error', text: t('members.inviteMailFailed') });
        reload();
      }} />

      {!data ? <p className="text-sm text-slate-500">{t('common.loading')}</p> : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{t('common.name')}</th><th className="px-4 py-3">{t('common.email')}</th>
                  <th className="px-4 py-3">{t('members.col.role')}</th><th className="px-4 py-3">{t('members.col.access')}</th><th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.members.map(m => (
                  <tr key={m.userId} className={m.isActive ? '' : 'text-slate-400'}>
                    <td className="px-4 py-3 font-medium">{m.name}{m.isSelf && <span className="ml-2 text-xs text-slate-500">{t('members.you')}</span>}</td>
                    <td className="px-4 py-3">{m.email}</td>
                    <td className="px-4 py-3">
                      {m.isSelf ? roleLabel(m.role) : (
                        <select aria-label={t('members.roleOf', { name: m.name })} disabled={busy} value={m.role} className="rounded-md border border-slate-300 bg-white px-2 py-1"
                          onChange={e => void patch(m, { role: e.target.value }, t('members.roleChanged'))}>
                          <option value="MANAGER">{roleLabel('MANAGER')}</option>
                          <option value="TENANT_ADMIN">{roleLabel('TENANT_ADMIN')}</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">{t(m.isActive ? 'members.active' : 'members.inactive')}</td>
                    <td className="px-4 py-3 text-right">
                      {!m.isSelf && <button disabled={busy} onClick={() => toggle(m)} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50">{t(m.isActive ? 'common.disable' : 'common.enable')}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.invitations.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-3 text-lg font-semibold">{t('members.pending')}</h2>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {data.invitations.map(i => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium">{i.name} · {i.email}</p>
                      <p className="text-xs text-slate-500">{roleLabel(i.role)} · {i.expired ? t('members.linkExpired') : t('members.until', { date: date(i.expiresAt) })}</p>
                    </div>
                    <div className="flex gap-2">
                      <button disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
                        onClick={() => void run(async () => {
                          const r = await post<InvitationSentResponse>(`/api/members/invitations/${i.id}/resend`);
                          if (!r.invitationSent) throw new ApiError(502, t('members.resendFailed'));
                        }, t('members.resent', { email: i.email }))}>{t('members.resend')}</button>
                      <button disabled={busy} className="rounded-md px-3 py-1 text-red-700 hover:bg-red-50"
                        onClick={() => void run(() => post(`/api/members/invitations/${i.id}/revoke`), t('members.revoked'))}>{t('members.revoke')}</button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function InviteForm({ onSent }: { onSent: (sent: boolean, email: string) => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ email: '', name: '', role: 'MANAGER' as TenantRole });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<InvitationSentResponse>('/api/members/invitations', form);
      onSent(r.invitationSent, form.email);
      setForm({ email: '', name: '', role: 'MANAGER' });
    } catch (e) { setError(e instanceof ApiError ? e.message : t('common.actionFailed')); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mb-8 grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
      {error && <div className="sm:col-span-4"><Notice>{error}</Notice></div>}
      <Field label={t('common.email')} type="email" required maxLength={320} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
      <Field label={t('common.name')} required maxLength={200} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">{t('members.col.role')}</span>
        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as TenantRole })} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2">
          <option value="MANAGER">{t('role.MANAGER')}</option>
          <option value="TENANT_ADMIN">{t('role.TENANT_ADMIN')}</option>
        </select>
      </label>
      <div className="w-full sm:w-40"><Button type="submit" disabled={busy}>{busy ? t('common.sending') : t('members.invite')}</Button></div>
    </form>
  );
}
