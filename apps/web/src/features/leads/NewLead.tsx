'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '../../components/ui';
import { ApiError, post } from '../auth/api';

/** Ручная заявка (L4): звонок или визит — имя и хотя бы один контакт. */
export function NewLead() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.email.trim() && !form.phone.trim()) { setError('Укажите email или телефон'); return; }
    setBusy(true);
    setError(null);
    try {
      const { id } = await post<{ id: string }>('/api/leads', form);
      router.push(`/leads/${id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Не удалось сохранить заявку');
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <Link href="/leads" className="text-sm text-teal-800 hover:underline">← Ко всем заявкам</Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold tracking-tight">Новая заявка</h1>
      <form onSubmit={submit} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        {error && <Notice>{error}</Notice>}
        <Field label="Имя" required maxLength={200} value={form.name} onChange={set('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email" type="email" maxLength={320} value={form.email} onChange={set('email')} />
          <Field label="Телефон" type="tel" maxLength={50} value={form.phone} onChange={set('phone')} />
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Сообщение (необязательно)</span>
          <textarea rows={4} maxLength={5000} value={form.message} onChange={set('message')} className="w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <div className="w-48"><Button type="submit" disabled={busy}>{busy ? 'Сохранение…' : 'Создать заявку'}</Button></div>
      </form>
    </div>
  );
}
