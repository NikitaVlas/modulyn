import { translate } from '@modulyn/i18n';
import { AppHome } from '../features/auth/AppHome';
import { serverLocale } from '../i18n/server';
import { serverBrand } from '../lib/brand';
import { PlatformHome } from '../features/auth/PlatformHome';
import { TenantHome } from '../features/auth/TenantHome';
import { currentSite, firstParam } from '../lib/site';

/**
 * Главная страница зависит от hostname: app.<домен> — выбор компании, admin.<домен> — платформа,
 * <компания>.<домен> — CRM компании. Данные и права проверяет API; здесь только выбор интерфейса.
 */
export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const site = await currentSite();
  const params = await searchParams;
  if (site.kind === 'app') return <AppHome hosting={site.hosting} error={firstParam(params.error)} choose={firstParam(params.choose) === '1'} />;
  if (site.kind === 'platform') return <PlatformHome hosting={site.hosting} />;
  if (site.kind === 'tenant') return <TenantHome hosting={site.hosting} error={firstParam(params.error)} />;
  const locale = await serverLocale();
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16 sm:px-12">
      <p className="mb-12 text-sm font-semibold uppercase tracking-[0.25em] text-brand">{serverBrand().name}</p>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">{translate(locale, 'landing.title')}</h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">{translate(locale, 'landing.text')}</p>
    </main>
  );
}
