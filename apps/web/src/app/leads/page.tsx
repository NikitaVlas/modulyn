import { notFound } from 'next/navigation';
import { TenantHome } from '../../features/auth/TenantHome';
import { currentSite } from '../../lib/site';

/** Заявки компании (Phase 6 — сводка, Phase 7 — список) — только на поддомене компании. */
export default async function LeadsPage() {
  const site = await currentSite();
  if (site.kind !== 'tenant') notFound();
  return <TenantHome baseDomain={site.baseDomain} section="leads" />;
}
