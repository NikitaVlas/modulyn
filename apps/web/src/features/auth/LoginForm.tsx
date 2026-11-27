'use client';

import { type Hosting } from '@modulyn/contracts';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AuthProvidersResponse, LoginResponse, TenantInfoResponse } from '@modulyn/contracts';
import { Brand, Button, Card, Centered, Field, Notice } from '../../components/ui';
import { LanguageSwitcher, useI18n } from '../../i18n/client';
import { ApiError, api, originOf, post } from './api';

interface Props {
  context: 'app' | 'platform';
  hosting: Hosting;
  /** Компания, из которой пришёл пользователь (?tenant=nova): после входа переход сразу в неё. */
  tenant?: string | undefined;
  error?: string | undefined;
  /** ?next=invite — после входа вернуться к принятию приглашения (5.2). */
  returnTo?: 'invite' | undefined;
}

/** Страница входа app.<домен> (пользователи) и admin.<домен> (платформа). Пароль вводится только здесь (A5). */
export function LoginForm({ context, hosting, tenant, error, returnTo }: Props) {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(error === 'google' ? t('login.googleFailed') : null);
  const [companyName, setCompanyName] = useState<string | null>(null);
  const [google, setGoogle] = useState(false);
  const [mfa, setMfa] = useState(false);
  const [code, setCode] = useState('');
  const router = useRouter();

  useEffect(() => {
    if (context !== 'app') return;
    api<AuthProvidersResponse>('/api/auth/providers', {}, { retry: false }).then(p => setGoogle(p.google), () => undefined);
    if (tenant) api<TenantInfoResponse>(`/api/auth/tenant-name?slug=${encodeURIComponent(tenant)}`, {}, { retry: false })
      .then(info => setCompanyName(info.displayName), () => undefined);
  }, [context, tenant]);

  const next = () => (returnTo === 'invite' ? '/invite' : tenant ? originOf(tenant, hosting) + '/api/auth/handoff/start' : '/');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const result = await post<LoginResponse>('/api/auth/login', { email, password }, { retry: false });
      // Администратор платформы с настроенным вторым фактором: сессии ещё нет, нужен код (B10).
      if (result.mfaRequired) { setMfa(true); setBusy(false); return; }
      window.location.assign(next());
    } catch (e) {
      setMessage(e instanceof ApiError && (e.status === 401 || e.status === 429 || e.status === 400)
        ? (e.status === 401 ? t('login.invalidCredentials') : e.message)
        : t('common.serviceDownRetry'));
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await post('/api/auth/mfa', { code: code.trim() }, { retry: false });
      router.replace('/');
    } catch (e) {
      // Истекло время второго шага — снова пароль; неверный код — повторить код.
      if (e instanceof ApiError && e.status === 401 && e.code !== 'MFA_INVALID_CODE') { setMfa(false); setPassword(''); }
      setMessage(e instanceof ApiError && e.status === 429 ? e.message : t('login.invalidCode'));
      setBusy(false);
    }
  }

  const title = context === 'platform' ? t('login.titlePlatform') : companyName ? t('login.titleCompany', { company: companyName }) : t('login.title');
  const header = <div className="flex items-center justify-between gap-3"><Brand /><LanguageSwitcher /></div>;
  if (mfa) {
    return (
      <Centered>
        {header}
        <h1 className="mb-2 mt-3 text-2xl font-semibold tracking-tight">{t('login.mfaTitle')}</h1>
        <p className="mb-6 text-sm text-slate-600">{t('login.mfaText')}</p>
        <Card>
          <form onSubmit={submitCode} className="space-y-4">
            {message && <Notice>{message}</Notice>}
            <Field label={t('login.code')} autoComplete="one-time-code" required maxLength={16} value={code} onChange={e => setCode(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? t('common.checking') : t('common.confirm')}</Button>
          </form>
        </Card>
      </Centered>
    );
  }
  return (
    <Centered>
      {header}
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          {message && <Notice>{message}</Notice>}
          <Field label={t('common.email')} type="email" name="email" autoComplete="username" required maxLength={320} value={email} onChange={e => setEmail(e.target.value)} />
          <Field label={t('common.password')} type="password" name="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={e => setPassword(e.target.value)} />
          <Button type="submit" disabled={busy}>{busy ? t('common.signingIn') : t('common.signIn')}</Button>
        </form>
        {google && (
          <>
            <div className="my-4 flex items-center gap-3 text-xs text-slate-400"><span className="h-px flex-1 bg-slate-200" />{t('common.or')}<span className="h-px flex-1 bg-slate-200" /></div>
            <a href={'/api/auth/google' + (tenant ? `?tenant=${encodeURIComponent(tenant)}` : '')}
              className="block w-full rounded-md border border-slate-300 bg-white px-4 py-2 text-center text-sm font-medium text-slate-800 hover:bg-slate-50">
              {t('login.google')}
            </a>
          </>
        )}
      </Card>
      {context === 'app' && (
        <>
          <Link href="/reset-password" className="mt-4 block text-center text-sm text-slate-600 hover:text-brand">{t('login.forgot')}</Link>
          <p className="mt-4 text-xs leading-5 text-slate-500">{t('login.noSignup')}</p>
        </>
      )}
    </Centered>
  );
}
