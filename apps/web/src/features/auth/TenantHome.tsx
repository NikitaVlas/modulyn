'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { TenantMeResponse } from '@modulyn/contracts';
import { Brand, Button, Centered, Loading, Notice } from '../../components/ui';
import { MembersAdmin } from '../members/MembersAdmin';
import { ApiError, api, originOf, post } from './api';

const ROLE: Record<string, string> = { TENANT_ADMIN: 'Администратор', MANAGER: 'Менеджер' };

/**
 * Каркас CRM компании (3.7): шапка с названием компании, пользователь, переключатель компаний, выход.
 * Нет сессии этой компании — переход через центральный вход (/api/auth/handoff/start).
 */
export function TenantHome({ baseDomain, error, section = 'home' }: { baseDomain: string; error?: string | undefined; section?: 'home' | 'users' }) {
  const [me, setMe] = useState<TenantMeResponse | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'handoff-error' | 'missing' | 'failed'>(error === 'handoff' ? 'handoff-error' : 'loading');

  useEffect(() => {
    if (error === 'handoff') return;
    api<TenantMeResponse>('/api/auth/me').then(data => { setMe(data); setState('ready'); }, e => {
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
          <Notice>Не удалось открыть сессию компании. Ссылка для входа одноразовая и действует одну минуту.</Notice>
          {/* eslint-disable-next-line @next/next/no-location-assign-relative-destination -- маршрут API, не страница */}
          <Button onClick={() => { window.location.href = '/api/auth/handoff/start'; }}>Попробовать снова</Button>
        </div>
      </Centered>
    );
  }
  if (state === 'missing') return <Centered><Brand /><h1 className="mt-3 text-xl font-semibold">Страница не найдена</h1></Centered>;
  if (state === 'failed') return <Centered><Notice>Сервис временно недоступен. Обновите страницу позже.</Notice></Centered>;
  if (!me) return <Loading />;

  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div>
            <Brand />
            <p className="text-lg font-semibold">{me.tenant.displayName}</p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-sm">
            <Link href="/" className={`rounded-md px-3 py-1.5 hover:bg-slate-100 ${section === 'home' ? 'font-semibold' : ''}`}>Главная</Link>
            {/* Пункт меню только для администратора; доступ к разделу всё равно проверяет сервер (5.5). */}
            {me.role === 'TENANT_ADMIN' && <Link href="/users" className={`rounded-md px-3 py-1.5 hover:bg-slate-100 ${section === 'users' ? 'font-semibold' : ''}`}>Пользователи</Link>}
            <span className="text-slate-600">{me.user.name} · {ROLE[me.role] ?? me.role}</span>
            <a href={originOf('app', baseDomain) + '/?choose=1'} className="rounded-md px-3 py-1.5 hover:bg-slate-100">Сменить компанию</a>
            <a href="/password" className="rounded-md px-3 py-1.5 hover:bg-slate-100">Пароль</a>
            <button onClick={logout} className="rounded-md border border-slate-300 px-3 py-1.5 hover:bg-slate-50">Выйти</button>
          </nav>
        </div>
      </header>
      {section === 'users' ? (
        me.role === 'TENANT_ADMIN'
          ? <MembersAdmin />
          : <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6"><Notice>Раздел доступен только администратору компании.</Notice></main>
      ) : (
        <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <h1 className="text-2xl font-semibold tracking-tight">Добро пожаловать, {me.user.name}</h1>
          <p className="mt-3 max-w-xl leading-7 text-slate-600">Вы вошли в {me.tenant.displayName}. Разделы заявок и модулей появятся на следующих этапах.</p>
        </main>
      )}
    </div>
  );
}
