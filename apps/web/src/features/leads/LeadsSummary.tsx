'use client';

import { useEffect, useState } from 'react';
import type { LeadStatus, LeadsSummaryResponse } from '@modulyn/contracts';
import { Notice } from '../../components/ui';
import { useI18n } from '../../i18n/client';
import { ApiError, api } from '../auth/api';

export const LEAD_STATUSES: LeadStatus[] = ['NEW', 'IN_PROGRESS', 'CONTACTED', 'CONVERTED', 'CLOSED'];

/** Сводка заявок по статусам (модуль «Заявки», M8). Отключённый модуль — понятное сообщение (M4, M7). */
export function LeadsSummary() {
  const { t } = useI18n();
  const [data, setData] = useState<LeadsSummaryResponse | null>(null);
  const [error, setError] = useState<'disabled' | 'failed' | null>(null);

  useEffect(() => {
    api<LeadsSummaryResponse>('/api/leads/summary').then(setData, e => setError(e instanceof ApiError && e.status === 403 ? 'disabled' : 'failed'));
  }, []);

  if (error) return <Notice>{t(error === 'disabled' ? 'leads.disabled' : 'leads.loadFailed')}</Notice>;
  if (!data) return <p className="text-sm text-slate-500">{t('common.loading')}</p>;
  return (
    <div>
      <p className="mb-3 text-sm text-slate-600">{t('leads.total')} <b>{data.total}</b></p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {LEAD_STATUSES.map(s => (
          <li key={s} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{t(`leadStatuses.${s}` as const)}</p>
            <p className="mt-1 text-2xl font-semibold">{data.byStatus[s]}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
