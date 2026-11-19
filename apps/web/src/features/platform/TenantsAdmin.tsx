'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { CreateTenantResponse, InvitationSentResponse, ModuleKey, PlatformTenant, PlatformTenantModule } from '@modulyn/contracts';
import { Button, Field, Notice } from '../../components/ui';
import { useI18n } from '../../i18n/client';
import { ApiError, api, originOf, post } from '../auth/api';

const STATUS_STYLE: Record<PlatformTenant['status'], string> = {
  ACTIVE: 'bg-teal-50 text-teal-800',
  SUSPENDED: 'bg-slate-100 text-slate-600',
};

function useErrorText() {
  const { t } = useI18n();
  return useCallback((e: unknown) => (e instanceof ApiError ? e.message : t('common.actionFailed')), [t]);
}

/**
 * Компании платформы (4.2–4.4): список, создание с первым администратором, названия, отключение и включение.
 * Администратор платформы видит только настройки компаний и число участников — без лидов и персональных данных (B6).
 */
export function TenantsAdmin({ baseDomain }: { baseDomain: string }) {
  const { t, date } = useI18n();
  const errorText = useErrorText();
  const [tenants, setTenants] = useState<PlatformTenant[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreateTenantResponse | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<PlatformTenant[]>('/api/platform/tenants').then(list => { setTenants(list); setError(null); }, e => setError(errorText(e)));
  }, [errorText]);
  useEffect(() => { reload(); }, [reload]);

  const current = tenants?.find(x => x.id === selected) ?? null;

  return (
    <section className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">{t('platform.companies')}</h1>
        {!creating && <div className="w-56"><Button onClick={() => { setCreating(true); setCreated(null); setSelected(null); }}>{t('platform.newCompany')}</Button></div>}
      </div>
      {error && <div className="mb-4"><Notice>{error}</Notice></div>}
      {created && <CreatedNotice result={created} baseDomain={baseDomain} onClose={() => setCreated(null)} />}
      {creating && <CreateForm onCancel={() => setCreating(false)} onCreated={r => { setCreating(false); setCreated(r); reload(); }} />}
      {current && <TenantDetails tenant={current} baseDomain={baseDomain} onClose={() => setSelected(null)} onChanged={reload} />}

      {!tenants ? <p className="text-sm text-slate-500">{t('common.loading')}</p> : tenants.length === 0 ? (
        <p className="text-sm text-slate-600">{t('platform.noCompanies')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">{t('platform.col.company')}</th><th className="px-4 py-3">{t('platform.col.subdomain')}</th>
                <th className="px-4 py-3">{t('platform.col.status')}</th><th className="px-4 py-3">{t('platform.col.members')}</th><th className="px-4 py-3">{t('platform.col.created')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {tenants.map(x => (
                <tr key={x.id} className="cursor-pointer hover:bg-slate-50" onClick={() => { setSelected(x.id); setCreating(false); }}>
                  <td className="px-4 py-3"><p className="font-medium">{x.displayName}</p><p className="text-xs text-slate-500">{x.name}</p></td>
                  <td className="px-4 py-3 font-mono text-xs">{x.slug}.{baseDomain}</td>
                  <td className="px-4 py-3"><span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[x.status]}`}>{t(`platform.status.${x.status}` as const)}</span></td>
                  <td className="px-4 py-3">{x.activeMembers}</td>
                  <td className="px-4 py-3 text-slate-600">{date(x.createdAt)}</td>
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
  const { t } = useI18n();
  const errorText = useErrorText();
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
    <Panel title={t('platform.newCompany')}>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        {error && <div className="sm:col-span-2"><Notice>{error}</Notice></div>}
        <Field label={t('platform.legalName')} required maxLength={200} value={form.name} onChange={set('name')} />
        <Field label={t('platform.displayNameHint')} required maxLength={200} value={form.displayName} onChange={set('displayName')} />
        <div className="sm:col-span-2">
          <Field label={t('platform.subdomainHint')} required maxLength={63} pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" placeholder="nova" value={form.slug} onChange={e => setForm({ ...form, slug: e.target.value.toLowerCase() })} />
        </div>
        <Field label={t('platform.adminEmail')} type="email" required maxLength={320} value={form.adminEmail} onChange={set('adminEmail')} />
        <Field label={t('platform.adminName')} required maxLength={200} value={form.adminName} onChange={set('adminName')} />
        <div className="flex flex-wrap gap-3 sm:col-span-2">
          <div className="w-48"><Button type="submit" disabled={busy}>{busy ? t('platform.creating') : t('platform.create')}</Button></div>
          <div className="w-32"><Button type="button" variant="secondary" onClick={onCancel}>{t('common.cancel')}</Button></div>
        </div>
      </form>
    </Panel>
  );
}

/** C3: первый администратор получает приглашение по email; пароль платформа больше не видит и не передаёт. */
function CreatedNotice({ result, baseDomain, onClose }: { result: CreateTenantResponse; baseDomain: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Panel title={t('platform.createdTitle', { name: result.tenant.displayName })}>
      <p className="text-sm text-slate-700">{t('platform.address')} <span className="font-mono">{originOf(result.tenant.slug, baseDomain)}</span></p>
      <div className="mt-4">
        {result.invitationSent
          ? <Notice tone="info">{t('platform.inviteSent', { email: result.firstAdmin.email })}</Notice>
          : <Notice>{t('platform.inviteFailed', { email: result.firstAdmin.email })}</Notice>}
      </div>
      <div className="mt-4 w-32"><Button onClick={onClose}>{t('common.done')}</Button></div>
    </Panel>
  );
}

/** Модули компании (6.2, M2): включает и отключает только платформа; данные при отключении сохраняются (M5). */
function TenantModules({ tenant }: { tenant: PlatformTenant }) {
  const { t } = useI18n();
  const errorText = useErrorText();
  const [modules, setModules] = useState<PlatformTenantModule[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  // Названия модулей — из словаря по ключу модуля (каталог в БД хранит одно название).
  const moduleName = (key: ModuleKey) => t(`module.${key}.name` as const);

  useEffect(() => {
    api<PlatformTenantModule[]>(`/api/platform/tenants/${tenant.id}/modules`).then(setModules, e => setMessage({ tone: 'error', text: errorText(e) }));
  }, [tenant.id, errorText]);

  async function toggle(m: PlatformTenantModule) {
    if (m.enabled && !window.confirm(t('platform.moduleDisableConfirm', { module: moduleName(m.key), company: tenant.displayName }))) return;
    setBusy(true);
    setMessage(null);
    try {
      setModules(await api<PlatformTenantModule[]>(`/api/platform/tenants/${tenant.id}/modules/${m.key}`, { method: 'PATCH', body: JSON.stringify({ enabled: !m.enabled }) }));
      setMessage({ tone: 'info', text: t(m.enabled ? 'platform.moduleOff' : 'platform.moduleOn', { module: moduleName(m.key) }) });
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  return (
    <div className="mt-6 border-t border-slate-200 pt-5">
      <p className="mb-3 text-sm font-medium">{t('platform.modules')}</p>
      {message && <div className="mb-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {!modules ? <p className="text-sm text-slate-500">{t('common.loading')}</p> : (
        <ul className="space-y-2">
          {modules.map(m => (
            <li key={m.key} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 px-4 py-3">
              <div><p className="font-medium">{moduleName(m.key)}</p><p className="text-xs text-slate-500">{t(`module.${m.key}.description` as const)}</p></div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" role="switch" aria-label={t('platform.moduleAria', { module: moduleName(m.key) })} checked={m.enabled} disabled={busy} onChange={() => void toggle(m)} />
                {t(m.enabled ? 'platform.moduleOnState' : 'platform.moduleOffState')}
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
  const { t } = useI18n();
  const errorText = useErrorText();
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
        ? { tone: 'info', text: t('members.invited', { email }) }
        : { tone: 'error', text: t('platform.inviteAdminMailFailed') });
      setEmail(''); setName('');
    } catch (e) { setMessage({ tone: 'error', text: errorText(e) }); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="mt-6 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <p className="text-sm font-medium sm:col-span-3">{t('platform.inviteAdmin')}</p>
      {message && <div className="sm:col-span-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      <Field label={t('common.email')} type="email" required maxLength={320} value={email} onChange={e => setEmail(e.target.value)} />
      <Field label={t('common.name')} required maxLength={200} value={name} onChange={e => setName(e.target.value)} />
      <div className="w-full sm:w-40"><Button type="submit" variant="secondary" disabled={busy || tenant.status !== 'ACTIVE'}>{t('members.invite')}</Button></div>
    </form>
  );
}

function TenantDetails({ tenant, baseDomain, onClose, onChanged }: { tenant: PlatformTenant; baseDomain: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useI18n();
  const errorText = useErrorText();
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
      if (!window.confirm(t('platform.suspendConfirm', { name: tenant.displayName }))) return;
      void patch({ status: 'SUSPENDED' }, t('platform.suspended'));
    } else {
      void patch({ status: 'ACTIVE' }, t('platform.activated'));
    }
  }

  return (
    <Panel title={tenant.displayName}>
      <form onSubmit={e => { e.preventDefault(); void patch({ name, displayName }, t('platform.saved')); }} className="grid gap-4 sm:grid-cols-2">
        {message && <div className="sm:col-span-2"><Notice tone={message.tone}>{message.text}</Notice></div>}
        <Field label={t('platform.legalName')} required maxLength={200} value={name} onChange={e => setName(e.target.value)} />
        <Field label={t('platform.displayName')} required maxLength={200} value={displayName} onChange={e => setDisplayName(e.target.value)} />
        <p className="text-sm text-slate-600 sm:col-span-2">
          {t('platform.details', { subdomain: `${tenant.slug}.${baseDomain}`, members: tenant.activeMembers, status: t(`platform.status.${tenant.status}` as const) })}
        </p>
        <div className="flex flex-wrap gap-3 sm:col-span-2">
          <div className="w-40"><Button type="submit" disabled={busy}>{t('common.save')}</Button></div>
          <div className="w-40"><Button type="button" variant="secondary" disabled={busy} onClick={toggleStatus}>{t(tenant.status === 'ACTIVE' ? 'common.disable' : 'common.enable')}</Button></div>
          <div className="w-32"><Button type="button" variant="secondary" onClick={onClose}>{t('common.close')}</Button></div>
        </div>
      </form>
      <TenantModules tenant={tenant} />
      <InviteAdmin tenant={tenant} />
    </Panel>
  );
}
