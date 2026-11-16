import { notFound } from 'next/navigation';
import { InviteAccept } from '../../features/members/InviteAccept';
import { currentSite, firstParam } from '../../lib/site';

/** Приглашение по ссылке из письма (5.2) — только на app.<домен>. */
export default async function InvitePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await currentSite();
  if (site.kind !== 'app') notFound();
  return <InviteAccept baseDomain={site.baseDomain} error={firstParam((await searchParams).error)} />;
}
