'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { InvitationSentResponse, MemberEntry, MembersResponse, TenantRole } from '@modulyn/contracts';
import { Button, Field, Notice } from '../../components/ui';
import { ApiError, api, post } from '../auth/api';

const ROLE: Record<TenantRole, string> = { TENANT_ADMIN: 'Администратор', MANAGER: 'Менеджер' };

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Не удалось выполнить действие';
}

/**
 * Пользователи компании (5.4): участники, ожидающие приглашения, приглашение, роль и доступ.
 * Права проверяет сервер (только администратор компании); здесь — удобный интерфейс к ним.
 */
export function MembersAdmin() {
  const [data, setData] = useState<MembersResponse | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api<MembersResponse>('/api/members').then(setData, e => setMessage({ tone: 'error', text: errorText(e) }));
  }, []);
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
    if (m.isActive && !window.confirm(`Отключить доступ ${m.name} к компании? Все его сеансы в этой компании завершатся.`)) return;
    void patch(m, { isActive: !m.isActive }, m.isActive ? 'Доступ отключён' : 'Доступ включён — человек входит заново');
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Пользователи</h1>
      {message && <div className="mb-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      <InviteForm onSent={(sent, email) => {
        setMessage(sent
          ? { tone: 'info', text: `Приглашение отправлено на ${email}` }
          : { tone: 'error', text: 'Приглашение создано, но письмо отправить не удалось. Попробуйте «Отправить повторно».' });
        reload();
      }} />

      {!data ? <p className="text-sm text-slate-500">Загрузка…</p> : (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-3">Имя</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Роль</th><th className="px-4 py-3">Доступ</th><th className="px-4 py-3" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.members.map(m => (
                  <tr key={m.userId} className={m.isActive ? '' : 'text-slate-400'}>
                    <td className="px-4 py-3 font-medium">{m.name}{m.isSelf && <span className="ml-2 text-xs text-slate-500">(вы)</span>}</td>
                    <td className="px-4 py-3">{m.email}</td>
                    <td className="px-4 py-3">
                      {m.isSelf ? ROLE[m.role] : (
                        <select aria-label={`Роль ${m.name}`} disabled={busy} value={m.role} className="rounded-md border border-slate-300 bg-white px-2 py-1"
                          onChange={e => void patch(m, { role: e.target.value }, 'Роль изменена')}>
                          <option value="MANAGER">{ROLE.MANAGER}</option>
                          <option value="TENANT_ADMIN">{ROLE.TENANT_ADMIN}</option>
                        </select>
                      )}
                    </td>
                    <td className="px-4 py-3">{m.isActive ? 'Активен' : 'Отключён'}</td>
                    <td className="px-4 py-3 text-right">
                      {!m.isSelf && <button disabled={busy} onClick={() => toggle(m)} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50">{m.isActive ? 'Отключить' : 'Включить'}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {data.invitations.length > 0 && (
            <div className="mt-8">
              <h2 className="mb-3 text-lg font-semibold">Ожидают принятия</h2>
              <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
                {data.invitations.map(i => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <div>
                      <p className="font-medium">{i.name} · {i.email}</p>
                      <p className="text-xs text-slate-500">{ROLE[i.role]} · {i.expired ? 'ссылка истекла' : `до ${new Date(i.expiresAt).toLocaleDateString('ru-RU')}`}</p>
                    </div>
                    <div className="flex gap-2">
                      <button disabled={busy} className="rounded-md border border-slate-300 px-3 py-1 hover:bg-slate-50"
                        onClick={() => void run(async () => {
                          const r = await post<InvitationSentResponse>(`/api/members/invitations/${i.id}/resend`);
                          if (!r.invitationSent) throw new ApiError(502, 'Письмо отправить не удалось. Попробуйте позже.');
                        }, `Новая ссылка отправлена на ${i.email}`)}>Отправить повторно</button>
                      <button disabled={busy} className="rounded-md px-3 py-1 text-red-700 hover:bg-red-50"
                        onClick={() => void run(() => post(`/api/members/invitations/${i.id}/revoke`), 'Приглашение отозвано')}>Отозвать</button>
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
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mb-8 grid gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
      {error && <div className="sm:col-span-4"><Notice>{error}</Notice></div>}
      <Field label="Email" type="email" required maxLength={320} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
      <Field label="Имя" required maxLength={200} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
      <label className="block text-sm">
        <span className="mb-1 block font-medium text-slate-700">Роль</span>
        <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as TenantRole })} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2">
          <option value="MANAGER">{ROLE.MANAGER}</option>
          <option value="TENANT_ADMIN">{ROLE.TENANT_ADMIN}</option>
        </select>
      </label>
      <div className="w-full sm:w-40"><Button type="submit" disabled={busy}>{busy ? 'Отправка…' : 'Пригласить'}</Button></div>
    </form>
  );
}
