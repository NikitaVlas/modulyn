import { notFound } from 'next/navigation';
import { TenantHome } from '../../../features/auth/TenantHome';
import { currentSite } from '../../../lib/site';

/** Ручная заявка (L4). */
export default async function NewLeadPage() {
  const site = await currentSite();
  if (site.kind !== 'tenant') notFound();
  return <TenantHome baseDomain={site.baseDomain} section="lead-new" />;
}
