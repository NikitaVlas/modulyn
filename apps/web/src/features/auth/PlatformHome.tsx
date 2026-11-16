'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PlatformMeResponse } from '@modulyn/contracts';
import { Brand, Button, Centered, Loading, Notice } from '../../components/ui';
import { ApiError, api, post } from './api';

/** admin.<домен>: защищённый раздел платформы. Управление компаниями — Phase 4. */
export function PlatformHome() {
  const [me, setMe] = useState<PlatformMeResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const router = useRouter();

  useEffect(() => {
    api<PlatformMeResponse>('/api/auth/me').then(setMe, e => {
      if (e instanceof ApiError && e.status === 401) router.replace('/login');
      else setFailed(true);
    });
  }, [router]);

  async function logout() {
    try { await post('/api/auth/logout', {}, { retry: false }); } finally { router.replace('/login'); }
  }

  if (failed) return <Centered><Notice>Сервис временно недоступен. Обновите страницу позже.</Notice></Centered>;
  if (!me) return <Loading />;
  return (
    <Centered>
      <Brand />
      <h1 className="mb-1 mt-3 text-2xl font-semibold tracking-tight">Администрирование платформы</h1>
      <p className="mb-6 text-sm text-slate-600">{me.admin.name} · {me.admin.email}</p>
      <Notice tone="info">Управление компаниями появится на этапе Platform Administration.</Notice>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <a href="/password" className="rounded-md border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium text-slate-800 hover:bg-slate-50">Сменить пароль</a>
        <Button variant="secondary" onClick={logout}>Выйти</Button>
      </div>
    </Centered>
  );
}
