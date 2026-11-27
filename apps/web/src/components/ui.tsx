'use client';

import type { ReactNode } from 'react';
import { useI18n } from '../i18n/client';
import { useBrand } from './brand';

/** Общие элементы интерфейса: минималистичные, без лишних визуальных деталей. */

/** Бренд установки (Phase 11, E4): логотип, если задан, иначе название продукта. */
export function Brand() {
  const { name, logoUrl } = useBrand();
  // eslint-disable-next-line @next/next/no-img-element -- логотип задаётся на сервере установки, оптимизация Next не нужна
  if (logoUrl) return <img src={logoUrl} alt={name} className="h-8 w-auto max-w-[12rem] object-contain" />;
  return <p className="text-xs font-semibold uppercase tracking-[0.25em] text-brand">{name}</p>;
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">{children}</div>
    </main>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm">{children}</div>;
}

export function Notice({ tone = 'error', children }: { tone?: 'error' | 'info'; children: ReactNode }) {
  const color = tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : 'border-slate-200 bg-slate-50 text-slate-700';
  return <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${color}`}>{children}</p>;
}

export function Field({ label, ...input }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{label}</span>
      <input {...input} className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-slate-900 outline-none focus:border-brand focus:ring-2 focus:ring-brand/20" />
    </label>
  );
}

export function Button({ variant = 'primary', ...props }: { variant?: 'primary' | 'secondary' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const style = variant === 'primary'
    ? 'bg-brand text-white hover:bg-brand-dark disabled:bg-brand/60'
    : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50';
  return <button {...props} className={`w-full rounded-md px-4 py-2 text-sm font-medium transition ${style} ${props.className ?? ''}`} />;
}

export function Loading() {
  const { t } = useI18n();
  return <Centered><Brand /><p className="mt-3 text-sm text-slate-500">{t('common.loading')}</p></Centered>;
}
