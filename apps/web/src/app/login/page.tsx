import { notFound, redirect } from 'next/navigation';
import { LoginForm } from '../../features/auth/LoginForm';
import { currentSite, firstParam } from '../../lib/site';

/** Форма входа есть только на app.<домен> и admin.<домен>. На поддомене компании — переход через центральный вход (A5). */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await currentSite();
  const params = await searchParams;
  if (site.kind === 'tenant') redirect('/api/auth/handoff/start');
  if (site.kind === 'unknown') notFound();
  const tenant = firstParam(params.tenant);
  return (
    <LoginForm
      context={site.kind}
      baseDomain={site.baseDomain}
      tenant={tenant && /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(tenant) ? tenant : undefined}
      error={firstParam(params.error)}
    />
  );
}
