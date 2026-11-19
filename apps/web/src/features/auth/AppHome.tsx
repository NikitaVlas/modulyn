'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { AppMeResponse } from '@modulyn/contracts';
import { Brand, Button, Card, Centered, Loading, Notice } from '../../components/ui';
import { LanguageSwitcher, useAccountLocale, useI18n } from '../../i18n/client';
import { ApiError, api, originOf, post } from './api';
import { PasswordForm } from './PasswordForm';

/**
 * app.<домен>: выбор компании (3.10). Список приходит с сервера и содержит только активные участия.
 * Переход — через /api/auth/handoff/start на поддомене компании (одноразовый код, A6).
 */
export function AppHome({ baseDomain, error, choose }: { baseDomain: string; error?: string | undefined; choose: boolean }) {
  const { t } = useI18n();
  const [me, setMe] = useState<AppMeResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  useAccountLocale(me?.locale);

  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    api<AppMeResponse>('/api/auth/me').then(data => {
      // Одна компания и пользователь не открыл выбор сам — сразу в неё.
      if (!data.passwordChangeRequired && data.companies.length === 1 && !error && !choose) {
        window.location.href = originOf(data.companies[0]!.slug, baseDomain) + '/api/auth/handoff/start';
        return;
      }
      setMe(data);
    }, e => {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setFailed(true);
    });
  }, [baseDomain, error, choose, router, reloadKey]);

  async function logout() {
    try { await post('/api/auth/logout', {}, { retry: false }); } finally { router.replace('/login'); }
  }

  if (failed) return <Centered><Notice>{t('common.serviceDown')}</Notice></Centered>;
  if (!me) return <Loading />;
  // Вход временным паролем (B8): сначала постоянный пароль, потом список компаний.
  if (me.passwordChangeRequired) return <PasswordForm forced onDone={() => { setMe(null); setReloadKey(k => k + 1); }} />;
  return (
    <Centered>
      <div className="flex items-center justify-between gap-3"><Brand /><LanguageSwitcher signedIn /></div>
      <h1 className="mb-1 mt-3 text-2xl font-semibold tracking-tight">{t('app.chooseCompany')}</h1>
      <p className="mb-6 text-sm text-slate-600">{me.user.name} · {me.user.email}</p>
      {error === 'no-access' && <div className="mb-4"><Notice>{t('app.noAccess')}</Notice></div>}
      <Card>
        {me.companies.length === 0
          ? <p className="text-sm text-slate-600">{t('app.noCompanies')}</p>
          : (
            <ul className="divide-y divide-slate-100">
              {me.companies.map(c => (
                <li key={c.slug}>
                  <a href={originOf(c.slug, baseDomain) + '/api/auth/handoff/start'} className="flex items-center justify-between py-3 hover:text-teal-800">
                    <span className="font-medium">{c.displayName}</span>
                    <span className="text-xs text-slate-500">{t(`role.${c.role}` as const)}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
      </Card>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <a href="/password" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium text-slate-800 hover:bg-slate-50">{t('app.changePassword')}</a>
        <Button variant="secondary" onClick={logout}>{t('common.signOut')}</Button>
      </div>
    </Centered>
  );
}
