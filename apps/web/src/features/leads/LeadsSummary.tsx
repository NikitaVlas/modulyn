'use client';

import { useEffect, useState } from 'react';
import type { LeadStatus, LeadsSummaryResponse } from '@modulyn/contracts';
import { Notice } from '../../components/ui';
import { ApiError, api } from '../auth/api';

export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: 'Новые', IN_PROGRESS: 'В работе', CONTACTED: 'Связались', CONVERTED: 'Клиенты', CLOSED: 'Закрыты',
};

/** Сводка заявок по статусам (модуль «Заявки», M8). Отключённый модуль — понятное сообщение (M4, M7). */
export function LeadsSummary() {
  const [data, setData] = useState<LeadsSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<LeadsSummaryResponse>('/api/leads/summary').then(setData, e => {
      setError(e instanceof ApiError && e.status === 403 ? 'Раздел «Заявки» отключён для вашей компании.' : 'Не удалось загрузить заявки.');
    });
  }, []);

  if (error) return <Notice>{error}</Notice>;
  if (!data) return <p className="text-sm text-slate-500">Загрузка…</p>;
  return (
    <div>
      <p className="mb-3 text-sm text-slate-600">Всего заявок: <b>{data.total}</b></p>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {(Object.keys(LEAD_STATUS_LABEL) as LeadStatus[]).map(s => (
          <li key={s} className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{LEAD_STATUS_LABEL[s]}</p>
            <p className="mt-1 text-2xl font-semibold">{data.byStatus[s]}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
