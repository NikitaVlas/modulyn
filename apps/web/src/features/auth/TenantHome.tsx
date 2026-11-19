'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { ModuleKey, TenantCapabilitiesResponse, TenantMeResponse } from '@modulyn/contracts';
import { Brand, Button, Centered, Loading, Notice } from '../../components/ui';
import { LanguageSwitcher, useAccountLocale, useI18n } from '../../i18n/client';
import { FormsAdmin } from '../forms/FormsAdmin';
import { LeadCard } from '../leads/LeadCard';
import { LeadsList, type LeadsQuery } from '../leads/LeadsList';
import { LeadsSummary } from '../leads/LeadsSummary';
import { NewLead } from '../leads/NewLead';
import { MembersAdmin } from '../members/MembersAdmin';
import { ApiError, api, originOf, post } from './api';

/**
 * Каркас CRM компании (3.7): шапка с названием компании, пользователь, язык, переключатель компаний, выход.
 * Нет сессии этой компании — переход через центральный вход (/api/auth/handoff/start).
 */
export function TenantHome({ baseDomain, error, section = 'home', leadsQuery = {}, leadId, leadDeleted = false }: {
  baseDomain: string; error?: string | undefined;
  section?: 'home' | 'users' | 'leads' | 'lead' | 'lead-new' | 'forms';
  /** Фильтры списка заявок из адреса страницы (7.5). */
  leadsQuery?: LeadsQuery;
  leadId?: string;
  /** Переход после удаления заявки — показать подтверждение над списком. */
  leadDeleted?: boolean;
}) {
  const { t } = useI18n();
  const [me, setMe] = useState<TenantMeResponse | null>(null);
  const [modules, setModules] = useState<ModuleKey[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'handoff-error' | 'missing' | 'failed'>(error === 'handoff' ? 'handoff-error' : 'loading');
  useAccountLocale(me?.locale);

  useEffect(() => {
    if (error === 'handoff') return;
    api<TenantMeResponse>('/api/auth/me').then(async data => {
      // Меню по включённым модулям компании (6.4). Это только удобство: доступ проверяет сервер.
      const caps = await api<TenantCapabilitiesResponse>('/api/tenant/capabilities').catch(() => ({ modules: [] as ModuleKey[] }));
      setModules(caps.modules);
      setMe(data);
      setState('ready');
    }, e => {
      // Маршрут API (nginx → Nest), а не страница Next.js: нужна полная навигация браузера.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (e instanceof ApiError && e.status === 401) window.location.href = '/api/auth/handoff/start';
      else if (e instanceof ApiError && e.status === 404) setState('missing');
      else setState('failed');
    });
  }, [error]);

  async function logout() {
    try { await post('/api/auth/logout', {}, { retry: false }); } finally { window.location.href = originOf('app', baseDomain) + '/login'; }
  }

  if (state === 'handoff-error') {
    return (
      <Centered>
        <Brand />
        <div className="mt-4 space-y-4">
          <Notice>{t('tenant.handoffFailed')}</Notice>
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination -- маршрут API, не страница */}
          <Button onClick={() => { window.location.href = '/api/auth/handoff/start'; }}>{t('tenant.tryAgain')}</Button>
        </div>
      </Centered>
    );
  }
  if (state === 'missing') return <Centered><Brand /><h1 className="mt-3 text-xl font-semibold">{t('common.notFound')}</h1></Centered>;
  if (state === 'failed') return <Centered><Notice>{t('common.serviceDown')}</Notice></Centered>;
  if (!me) return <Loading />;

  const adminOnly = <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6"><Notice>{t('common.adminOnly')}</Notice></main>;
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div>
            <Brand />
            <p className="text-lg font-semibold">{me.tenant.displayName}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link href="/" className={`rounded-md px-3 py-1.5 hover:bg-slate-100 ${section === 'home' ? 'font-semibold' : ''}`}>{t('nav.home')}</Link>
            {modules.includes('leads') && <Link href="/leads" className={`rounded-md px-3 py-1.5 hover:bg-slate-100 ${section.startsWith('lead') ? 'font-semibold' : ''}`}>{t('nav.leads')}</Link>}
            {me.role === 'TENANT_ADMIN' && modules.includes('leads') && <Link href="/forms" className={`rounded-md px-3 py-1.5 hover:bg-slate-100 ${section === 'forms' ? 'font-semibold' : ''}`}>{t('nav.intake')}</Link>}
            {/* Пункт меню только для администратора; доступ к разделу всё равно проверяет сервер (5.5). */}
            {me.role === 'TENANT_ADMIN' && <Link href="/users" className={`rounded-md px-3 py-1.5 hover:bg-slate-100 ${section === 'users' ? 'font-semibold' : ''}`}>{t('nav.users')}</Link>}
            <span className="text-slate-600">{me.user.name} · {t(`role.${me.role}` as const)}</span>
            <LanguageSwitcher signedIn />
            <a href={originOf('app', baseDomain) + '/?choose=1'} className="rounded-md px-3 py-1.5 hover:bg-slate-100">{t('nav.switchCompany')}</a>
            <a href="/password" className="rounded-md px-3 py-1.5 hover:bg-slate-100">{t('nav.password')}</a>
            <button onClick={logout} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">{t('common.signOut')}</button>
          </nav>
        </div>
      </header>
      {section === 'users' ? (
        me.role === 'TENANT_ADMIN' ? <MembersAdmin /> : adminOnly
      ) : section === 'forms' ? (
        me.role === 'TENANT_ADMIN' ? <FormsAdmin /> : adminOnly
      ) : section === 'leads' || section === 'lead' || section === 'lead-new' ? (
        // Сервер сам ответит MODULE_DISABLED, если модуль отключён, — разделы покажут сообщение.
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          {section === 'leads' && leadDeleted && <div className="mb-4"><Notice tone="info">{t('leads.deleted')}</Notice></div>}
          {section === 'leads' && <LeadsList query={leadsQuery} />}
          {section === 'lead' && leadId && <LeadCard id={leadId} role={me.role} />}
          {section === 'lead-new' && <NewLead />}
        </main>
      ) : (
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight">{t('tenant.welcome', { name: me.user.name })}</h1>
          <p className="mt-3 max-w-xl leading-7 text-slate-600">{t('tenant.signedInto', { company: me.tenant.displayName })}</p>
          {modules.includes('leads') && <section className="mt-8"><h2 className="mb-3 text-lg font-semibold">{t('leads.title')}</h2><LeadsSummary /></section>}
          {modules.length === 0 && <p className="mt-6 text-sm text-slate-500">{t('tenant.noModules')}</p>}
        </main>
      )}
    </div>
  );
}
