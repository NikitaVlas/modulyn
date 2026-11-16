'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CreateTenantResponse, InvitationSentResponse, PlatformTenant, PlatformTenantModule } from '@modulyn/contracts';
import { Button, Field, Notice } from '../../components/ui';
import { ApiError, api, originOf, post } from '../auth/api';

const STATUS: Record<PlatformTenant['status'], { text: string; style: string }> = {
  ACTIVE: { text: 'Активна', style: 'bg-teal-50 text-teal-800' },
  SUSPENDED: { text: 'Отключена', style: 'bg-slate-100 text-slate-600' },
};

function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : 'Не удалось выполнить действие';
}

/**
 * Компании платформы (4.2–4.4): список, создание с первым администратором, названия, отключение и включение.
 * Администратор платформы видит только настройки компаний и число участников — без лидов и персональных данных (B6).
 */
export function TenantsAdmin({ baseDomain }: { baseDomain: string }) {
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateTenantResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<PlatformTenant[]>('/api/platform/tenants').then(list => { setTenants(list); setError(null); }, e => setError(errorText(e)));
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const current = tenants?.find(t => t.id === selected) ?? null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Компании</h1>
        {!creating && <div className="w-48"><Button onClick={() => { setCreating(true); setCreated(null); setSelected(null); }}>Новая компания</Button></div>}
      </div>
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {created && <CreatedNotice result={created} baseDomain={baseDomain} onClose={() => setCreated(null)} />}
      {creating && <CreateForm onCancel={() => setCreating(false)} onCreated={r => { setCreating(false); setCreated(r); reload(); }} />}
      {current && <TenantDetails tenant={current} baseDomain={baseDomain} onClose={() => setSelected(null)} onChanged={reload} />}

      {!tenants ? <p className="text-sm text-slate-500">Загрузка…</p> : tenants.length === 0 ? (
        <p className="text-sm text-slate-600">Компаний пока нет.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr><th className="px-4 py-3">Компания</th><th className="px-4 py-3">Поддомен</th><th className="px-4 py-3">Статус</th><th className="px-4 py-3">Участники</th><th className="px-4 py-3">Создана</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tenants.map(t => (
                <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => { setSelected(t.id); setCreating(false); }}>
                  <td className="px-4 py-3"><p className="font-medium">{t.displayName}</p><p className="text-xs text-slate-500">{t.name}</p></td>
                  <td className="px-4 py-3 font-mono text-xs">{t.slug}.{baseDomain}</td>
                  <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-xs ${STATUS[t.status].style}`}>{STATUS[t.status].text}</span></td>
                  <td className="px-4 py-3">{t.activeMembers}</td>
                  <td className="px-4 py-3 text-slate-600">{new Date(t.createdAt).toLocaleDateString('ru-RU')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </div>
  );
}

function CreateForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (r: CreateTenantResponse) => void }) {
  const [form, setForm] = useState({ name: '', displayName: '', slug: '', adminEmail: '', adminName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { onCreated(await post<CreateTenantResponse>('/api/platform/tenants', form)); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  }

  return (
    <Panel title="Новая компания">
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Notice>{error}</Notice></div>}
        <Field label="Название (юридическое)" required maxLength={200} value={form.name} onChange={set('name')} />
        <Field label="Имя в интерфейсе, например «Nova CRM»" required maxLength={200} value={form.displayName} onChange={set('displayName')} />
        <div className="sm:col-span-2">
          <Field label="Поддомен (нельзя изменить после создания)" required maxLength={63} pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" placeholder="nova" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
        </div>
        <Field label="Email первого администратора" type="email" required maxLength={320} value={form.adminEmail} onChange={set('adminEmail')} />
        <Field label="Имя первого администратора" required maxLength={200} value={form.adminName} onChange={set('adminName')} />
        <div className="flex gap-3 sm:col-span-2">
          <div className="w-48"><Button type="submit" disabled={busy}>{busy ? 'Создание…' : 'Создать'}</Button></div>
          <div className="w-32"><Button type="button" variant="secondary" onClick={onCancel}>Отмена</Button></div>
        </div>
      </form>
    </Panel>
  );
}

/** C3: первый администратор получает приглашение по email; пароль платформа больше не видит и не передаёт. */
function CreatedNotice({ result, baseDomain, onClose }: { result: CreateTenantResponse; baseDomain: string; onClose: () => void }) {
  return (
    <Panel title={`Компания «${result.tenant.displayName}» создана`}>
      <p className="text-sm text-slate-700">Адрес: <span className="font-mono">{originOf(result.tenant.slug, baseDomain)}</span></p>
      <div className="mt-4">
        {result.invitationSent
          ? <Notice tone="info">Приглашение отправлено на {result.firstAdmin.email}. Ссылка действует 7 дней; администратор станет участником, когда примет его.</Notice>
          : <Notice>Компания создана, но письмо на {result.firstAdmin.email} отправить не удалось. Откройте карточку компании и отправьте приглашение повторно.</Notice>}
      </div>
      <div className="mt-4 w-32"><Button onClick={onClose}>Готово</Button></div>
    </Panel>
  );
}

/** Модули компании (6.2, M2): включает и отключает только платформа; данные при отключении сохраняются (M5). */
function TenantModules({ tenant }: { tenant: PlatformTenant }) {
  const [modules, setModules] = useState<PlatformTenantModule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    api<PlatformTenantModule[]>(`/api/platform/tenants/${tenant.id}/modules`).then(setModules, e => setMessage({ tone: 'error', text: errorText(e) }));
  }, [tenant.id]);

  async function toggle(m: PlatformTenantModule) {
    if (m.enabled && !window.confirm(`Отключить «${m.name}» для ${tenant.displayName}? Раздел сразу пропадёт у всех сотрудников компании; данные сохранятся.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      setModules(await api<PlatformTenantModule[]>(`/api/platform/tenants/${tenant.id}/modules/${m.key}`, { method: 'PATCH', body: JSON.stringify({ enabled: !m.enabled }) }));
      setMessage({ tone: 'info', text: m.enabled ? `«${m.name}» отключён` : `«${m.name}» включён` });
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-6 border-t border-slate-200 pt-5">
      <p className="mb-3 text-sm font-medium">Модули</p>
      {message && <div className="mb-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {!modules ? <p className="text-sm text-slate-500">Загрузка…</p> : (
        <ul className="space-y-2">
          {modules.map(m => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 px-4 py-3">
              <div><p className="font-medium">{m.name}</p><p className="text-xs text-slate-500">{m.description}</p></div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" role="switch" aria-label={`Модуль ${m.name}`} checked={m.enabled} disabled={busy} onChange={() => void toggle(m)} />
                {m.enabled ? 'Включён' : 'Выключен'}
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** C3/C4: повторная отправка первому администратору или приглашение нового администратора компании. */
function InviteAdmin({ tenant }: { tenant: PlatformTenant }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const r = await post<InvitationSentResponse>(`/api/platform/tenants/${tenant.id}/admin-invitations`, { email, name });
      setMessage(r.invitationSent
        ? { tone: 'info', text: `Приглашение отправлено на ${email}` }
        : { tone: 'error', text: 'Приглашение создано, но письмо отправить не удалось. Попробуйте позже.' });
      setEmail(''); setName('');
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mt-6 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <p className="text-sm font-medium sm:col-span-3">Пригласить администратора компании</p>
      {message && <div className="sm:col-span-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      <Field label="Email" type="email" required maxLength={320} value={email} onChange={e => setEmail(e.target.value)} />
      <Field label="Имя" required maxLength={200} value={name} onChange={e => setName(e.target.value)} />
      <div className="w-full sm:w-40"><Button type="submit" variant="secondary" disabled={busy || tenant.status !== 'ACTIVE'}>Пригласить</Button></div>
    </form>
  );
}

function TenantDetails({ tenant, baseDomain, onClose, onChanged }: { tenant: PlatformTenant; baseDomain: string; onClose: () => void; onChanged: () => void }) {
  const [name, setName] = useState(tenant.name);
  const [displayName, setDisplayName] = useState(tenant.displayName);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);

  async function patch(body: Record<string, string>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      await api<PlatformTenant>(`/api/platform/tenants/${tenant.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setMessage({ tone: 'info', text: done });
      onChanged();
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  function toggleStatus() {
    if (tenant.status === 'ACTIVE') {
      if (!window.confirm(`Отключить «${tenant.displayName}»? Поддомен сразу перестанет открываться, все пользователи выйдут из системы. Данные сохранятся.`)) return;
      void patch({ status: 'SUSPENDED' }, 'Компания отключена');
    } else {
      void patch({ status: 'ACTIVE' }, 'Компания включена. Пользователи входят заново.');
    }
  }

  return (
    <Panel title={tenant.displayName}>
      <form onSubmit={e => { e.preventDefault(); void patch({ name, displayName }, 'Сохранено'); }} className="grid gap-4 sm:grid-cols-2">
        {message && <div className="sm:col-span-2"><Notice tone={message.tone}>{message.text}</Notice></div>}
        <Field label="Название (юридическое)" required maxLength={200} value={name} onChange={e => setName(e.target.value)} />
        <Field label="Имя в интерфейсе" required maxLength={200} value={displayName} onChange={e => setDisplayName(e.target.value)} />
        <p className="text-sm text-slate-600 sm:col-span-2">
          Поддомен: <span className="font-mono">{tenant.slug}.{baseDomain}</span> (не меняется) · Участников: {tenant.activeMembers} · Статус: {STATUS[tenant.status].text}
        </p>
        <div className="flex flex-wrap gap-3 sm:col-span-2">
          <div className="w-40"><Button type="submit" disabled={busy}>Сохранить</Button></div>
          <div className="w-40"><Button type="button" variant="secondary" disabled={busy} onClick={toggleStatus}>{tenant.status === 'ACTIVE' ? 'Отключить' : 'Включить'}</Button></div>
          <div className="w-32"><Button type="button" variant="secondary" onClick={onClose}>Закрыть</Button></div>
        </div>
      </form>
      <TenantModules tenant={tenant} />
      <InviteAdmin tenant={tenant} />
    </Panel>
  );
}
