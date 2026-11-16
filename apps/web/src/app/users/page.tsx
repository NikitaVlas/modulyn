import { notFound } from 'next/navigation';
import { TenantHome } from '../../features/auth/TenantHome';
import { currentSite } from '../../lib/site';

/** Пользователи компании (5.4) — только на поддомене компании. */
export default async function UsersPage() {
  const site = await currentSite();
  if (site.kind !== 'tenant') notFound();
  return <TenantHome baseDomain={site.baseDomain} section="users" />;
}
