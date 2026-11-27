import { notFound } from 'next/navigation';
import { TenantHome } from '../../features/auth/TenantHome';
import { currentSite, firstParam } from '../../lib/site';

const KEYS = ['status', 'assignee', 'q', 'sort', 'page', 'pageSize'] as const;

/** Список заявок (7.5) — только на поддомене компании; фильтры приходят из адреса. */
export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await currentSite();
  if (site.kind !== 'tenant') notFound();
  const params = await searchParams;
  const query = Object.fromEntries(KEYS.map(k => [k, firstParam(params[k])]));
  // ?deleted=1 — переход после удаления заявки (Phase 9, F6): показать подтверждение; в запрос к API не передаётся.
  return <TenantHome hosting={site.hosting} section="leads" leadsQuery={query} leadDeleted={firstParam(params.deleted) === '1'} />;
}
