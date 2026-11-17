import { notFound } from 'next/navigation';
import { TenantHome } from '../../features/auth/TenantHome';
import { currentSite } from '../../lib/site';

/** Приём заявок с сайтов (8.9–8.11) — только на поддомене компании, для администратора. */
export default async function FormsPage() {
  const site = await currentSite();
  if (site.kind !== 'tenant') notFound();
  return <TenantHome baseDomain={site.baseDomain} section="forms" />;
}
