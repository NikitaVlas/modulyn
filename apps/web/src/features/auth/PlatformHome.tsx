'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PlatformMeResponse } from '@modulyn/contracts';
import { Brand, Centered, Loading, Notice } from '../../components/ui';
import { LanguageSwitcher, useAccountLocale, useI18n } from '../../i18n/client';
import { MfaSetup } from '../platform/MfaSetup';
import { TenantsAdmin } from '../platform/TenantsAdmin';
import { ApiError, api, post } from './api';
import { PasswordForm } from './PasswordForm';

/**
 * admin.<домен>: обязательные шаги (смена временного пароля → настройка второго фактора), затем раздел компаний.
 * Сервер сам не пустит дальше, пока шаги не пройдены; интерфейс только показывает нужный экран.
 */
export function PlatformHome({ baseDomain }: { baseDomain: string }) {
  const { t } = useI18n();
  const [me, setMe] = useState<PlatformMeResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const router = useRouter();
  useAccountLocale(me?.locale);

  const load = useCallback(() => {
    api<PlatformMeResponse>('/api/auth/me').then(setMe, e => {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setFailed(true);
    });
  }, [router]);
  useEffect(() => { load(); }, [load]);

  async function logout() {
    try { await post('/api/auth/logout', {}, { retry: false }); } finally { router.replace('/login'); }
  }

  if (failed) return <Centered><Notice>{t('common.serviceDown')}</Notice></Centered>;
  if (!me) return <Loading />;
  if (me.passwordChangeRequired) return <PasswordForm forced onDone={load} />;
  if (me.mfaSetupRequired) return <MfaSetup onDone={load} />;
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div><Brand /><p className="text-lg font-semibold">{t('login.titlePlatform')}</p></div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-slate-600">{me.admin.name}</span>
            <LanguageSwitcher signedIn />
            <a href="/password" className="rounded-md px-3 py-1.5 hover:bg-slate-100">{t('nav.password')}</a>
            <button onClick={logout} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">{t('common.signOut')}</button>
          </nav>
        </div>
      </header>
      <TenantsAdmin baseDomain={baseDomain} />
    </div>
  );
}
