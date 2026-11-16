'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Brand, Button, Card, Centered, Field, Notice } from '../../components/ui';
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

function RequestLink() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try { await post('/api/auth/password-reset/request', { email }, { retry: false }); setSent(true); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось отправить запрос'); }
    finally { setBusy(false); }
  }

  return (
    <Centered>
      <Brand />
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">Восстановление пароля</h1>
      <Card>
        {sent ? (
          <Notice tone="info">Если такой аккаунт есть, мы отправили на {email} письмо со ссылкой. Она действует 1 час.</Notice>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <Notice>{error}</Notice>}
            <Field label="Email" type="email" autoComplete="username" required maxLength={320} value={email} onChange={e => setEmail(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? 'Отправка…' : 'Отправить ссылку'}</Button>
          </form>
        )}
      </Card>
      <Link href="/login" className="mt-4 block text-center text-sm text-slate-600 hover:text-teal-800">Ко входу</Link>
    </Centered>
  );
}

function NewPassword({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password !== repeat) { setError('Пароли не совпадают'); return; }
    setBusy(true);
    setError(null);
    try { await post('/api/auth/password-reset/confirm', { token, newPassword: password }, { retry: false }); setDone(true); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Не удалось сменить пароль'); }
    finally { setBusy(false); }
  }

  return (
    <Centered>
      <Brand />
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">Новый пароль</h1>
      <Card>
        {done ? (
          <div className="space-y-4">
            <Notice tone="info">Пароль изменён. Все прежние сеансы завершены.</Notice>
            <Link href="/login" className="block w-full rounded-md bg-teal-800 px-4 py-2 text-center text-sm font-medium text-white hover:bg-teal-900">Войти</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {error && <Notice>{error}</Notice>}
            <Field label="Новый пароль (не меньше 12 символов)" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} />
            <Field label="Повторите пароль" type="password" autoComplete="new-password" required value={repeat} onChange={e => setRepeat(e.target.value)} />
            <Button type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Сохранить пароль'}</Button>
          </form>
        )}
      </Card>
    </Centered>
  );
}
