'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Brand, Button, Card, Centered, Field, Notice } from '../../components/ui';
import { ApiError, post } from './api';

/** Смена своего пароля (A10). Остальные сессии отзываются, этот браузер остаётся в системе. */
export function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const router = useRouter();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (next !== repeat) { setMessage({ tone: 'error', text: 'Новые пароли не совпадают' }); return; }
    setBusy(true);
    setMessage(null);
    try {
      await post('/api/auth/password', { currentPassword: current, newPassword: next });
      setCurrent(''); setNext(''); setRepeat('');
      setMessage({ tone: 'info', text: 'Пароль изменён. Другие устройства вышли из системы.' });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { router.replace('/'); return; }
      setMessage({ tone: 'error', text: e instanceof ApiError ? e.message : 'Не удалось изменить пароль' });
    } finally { setBusy(false); }
  }

  return (
    <Centered>
      <Brand />
      <h1 className="mb-6 mt-3 text-2xl font-semibold tracking-tight">Смена пароля</h1>
      <Card>
        <form onSubmit={submit} className="space-y-4">
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
          <Field label="Текущий пароль" type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} />
          <Field label="Новый пароль (не меньше 12 символов)" type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={next} onChange={e => setNext(e.target.value)} />
          <Field label="Повторите новый пароль" type="password" autoComplete="new-password" required value={repeat} onChange={e => setRepeat(e.target.value)} />
          <Button type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Сменить пароль'}</Button>
        </form>
      </Card>
      <Link href="/" className="mt-4 block text-center text-sm text-slate-600 hover:text-teal-800">Назад</Link>
    </Centered>
  );
}
