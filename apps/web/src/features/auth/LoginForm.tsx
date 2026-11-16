'use client';

import { useEffect, useState, type FormEvent } from 'react';
import type { AuthProvidersResponse, TenantInfoResponse } from '@modulyn/contracts';
import { Brand, Button, Card, Centered, Field, Notice } from '../../components/ui';
import { ApiError, api, originOf, post } from './api';

interface Props {
  context: 'app' | 'platform';
  baseDomain: string;
  /** Компания, из которой пришёл пользователь (?tenant=nova): после входа переход сразу в неё. */
  tenant?: string | undefined;
  error?: string | undefined;
}

const ERRORS: Record<string, string> = {
  google: 'Не удалось войти через Google. Вход возможен только для существующего аккаунта с подтверждённым email.',
};

/** Страница входа app.<домен> (пользователи) и admin.<домен> (платформа). Пароль вводится только здесь (A5). */
export function LoginForm({ context, baseDomain, tenant, error }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(error ? ERRORS[error] ?? null : null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);

  useEffect(() => {
    if (context !== 'app') return;
    api<AuthProvidersResponse>('/api/auth/providers', {}, { retry: false }).then(p => setGoogle(p.google), () => undefined);
    if (tenant) api<TenantInfoResponse>(`/api/auth/tenant-name?slug=${encodeURIComponent(tenant)}`, {}, { retry: false })
      .then(t => setCompanyName(t.displayName), () => undefined);
  }, [context, tenant]);

  const next = () => (tenant ? originOf(tenant, baseDomain) + '/api/auth/handoff/start' : '/');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await post('/api/auth/login', { email, password }, { retry: false });
      window.location.assign(next());
    } catch (e) {
      setMessage(e instanceof ApiError && (e.status === 401 || e.status === 429 || e.status === 400)
        ? (e.status === 401 ? 'Неверный email или пароль' : e.message)
        : 'Сервис временно недоступен. Попробуйте позже.');
      setBusy(false);
    }
  }

  const title = context === 'platform' ? 'Администрирование платформы' : companyName ? `Вход в ${companyName}` : 'Вход в CRM';
  return (
    <Centered>
      <Brand />
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          {message && <Notice>{message}</Notice>}
          <Field label="Email" type="email" name="email" autoComplete="username" required maxLength={320} value={email} onChange={e => setEmail(e.target.value)} />
          <Field label="Пароль" type="password" name="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} />
          <Button type="submit" disabled={busy}>{busy ? 'Вход…' : 'Войти'}</Button>
        </form>
        {google && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />или<span className="h-px flex-1 bg-slate-200" /></div>
            <a href={'/api/auth/google' + (tenant ? `?tenant=${encodeURIComponent(tenant)}` : '')}
              className="block w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium text-slate-800 hover:bg-slate-50">
              Войти через Google
            </a>
          </>
        )}
      </Card>
      {context === 'app' && <p className="mt-4 text-xs leading-5 text-slate-500">Регистрации нет: аккаунт создаёт администратор вашей компании.</p>}
    </Centered>
  );
}
