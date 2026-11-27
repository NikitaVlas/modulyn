'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, Notice } from '../../components/ui';
import { useI18n } from '../../i18n/client';
import { ApiError, post } from '../auth/api';

/** Ручная заявка (L4): звонок или визит — имя и хотя бы один контакт. */
export function NewLead() {
  const { t } = useI18n();
  const router = useRouter();
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm({ ...form, [key]: e.target.value });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form.email.trim() && !form.phone.trim()) { setError(t('leads.contactRequired')); return; }
    setBusy(true);
    setError(null);
    try {
      const { id } = await post<{ id: string }>('/api/leads', form);
      router.push(`/leads/${id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('leads.saveFailed'));
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl">
      <Link href="/leads" className="text-sm text-brand hover:underline">{t('leads.backToAll')}</Link>
      <h1 className="mb-6 mt-2 text-2xl font-semibold tracking-tight">{t('leads.new')}</h1>
      <form onSubmit={submit} className="space-y-4 rounded-lg border border-slate-200 bg-white p-5">
        {error && <Notice>{error}</Notice>}
        <Field label={t('common.name')} required maxLength={200} value={form.name} onChange={set('name')} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('common.email')} type="email" maxLength={320} value={form.email} onChange={set('email')} />
          <Field label={t('common.phone')} type="tel" maxLength={50} value={form.phone} onChange={set('phone')} />
        </div>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">{t('leads.messageOptional')}</span>
          <textarea rows={4} maxLength={5000} value={form.message} onChange={set('message')} className="w-full rounded-md border border-slate-300 px-3 py-2" />
        </label>
        <div className="w-56"><Button type="submit" disabled={busy}>{busy ? t('common.saving') : t('leads.create')}</Button></div>
      </form>
    </div>
  );
}
