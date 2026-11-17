import { notFound } from 'next/navigation';
import { TenantHome } from '../../../features/auth/TenantHome';
import { currentSite } from '../../../lib/site';

/** Карточка заявки (7.6). Доступ к заявке проверяет API: чужая или несуществующая — «не найдена». */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const site = await currentSite();
  if (site.kind !== 'tenant') notFound();
  return <TenantHome baseDomain={site.baseDomain} section="lead" leadId={(await params).id} />;
}
