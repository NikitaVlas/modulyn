'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Brand, Button, Card, Centered, Field, Notice } from '../../components/ui';
import { LanguageSwitcher, useI18n } from '../../i18n/client';
import { ApiError, post } from './api';

/**
 * Восстановление пароля (5.6, C7) на app.<домен>.
 * Без токена — запрос письма; с токеном в адресе после # — новый пароль (токен не уходит на сервер при открытии страницы).
 */
export function ResetPassword() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const value = window.location.hash.slice(1);
    if (value) history.replaceState(null, '', window.location.pathname);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- значение доступно только в браузере после монтирования
    setToken(value || null);
    setReady(true);
  }, []);

  if (!ready) return null;
  return token ? <NewPassword token={token} /> : <RequestLink />;
}

function Header() {
  return <div className="flex items-center justify-between gap-3"><Brand /><LanguageSwitcher /></div>;
}

function RequestLink() {
  const { t } = useI18n();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await post('/api/auth/password-reset/request', { email }, { retry: false }); setSent(true); }
    catch (e) { setError(e instanceof ApiError ? e.message : t('reset.requestFailed')); }
    finally { setBusy(false); }
  }

  return (
    <Centered>
      <Header />
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">{t('reset.title')}</h1>
      <Card>
        {sent ? (
          <Notice tone="info">{t('reset.sent', { email })}</Notice>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <Notice>{error}</Notice>}
            <Field label={t('common.email')} type="email" autoComplete="username" required maxLength={320} value={email} onChange={e => setEmail(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? t('common.sending') : t('reset.send')}</Button>
          </form>
        )}
      </Card>
      <Link href="/login" className="mt-4 block text-center text-sm text-slate-600 hover:text-teal-800">{t('reset.toLogin')}</Link>
    </Centered>
  );
}

function NewPassword({ token }: { token: string }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) { setError(t('password.mismatch')); return; }
    setBusy(true);
    setError(null);
    try { await post('/api/auth/password-reset/confirm', { token, newPassword: password }, { retry: false }); setDone(true); }
    catch (e) { setError(e instanceof ApiError ? e.message : t('password.failed')); }
    finally { setBusy(false); }
  }

  return (
    <Centered>
      <Header />
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">{t('reset.newTitle')}</h1>
      <Card>
        {done ? (
          <div className="space-y-4">
            <Notice tone="info">{t('reset.done')}</Notice>
            <Link href="/login" className="block w-full rounded-md bg-teal-800 px-4 py-2 text-center text-sm font-medium text-white hover:bg-teal-900">{t('common.signIn')}</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <Notice>{error}</Notice>}
            <Field label={t('password.new')} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} />
            <Field label={t('password.repeat')} type="password" autoComplete="new-password" required value={repeat} onChange={e => setRepeat(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? t('common.saving') : t('password.save')}</Button>
          </form>
        )}
      </Card>
    </Centered>
  );
}
