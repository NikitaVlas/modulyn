import { AppHome } from '../features/auth/AppHome';
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
  if (site.kind === 'app') return <AppHome baseDomain={site.baseDomain} error={firstParam(params.error)} choose={firstParam(params.choose) === '1'} />;
  if (site.kind === 'platform') return <PlatformHome />;
  if (site.kind === 'tenant') return <TenantHome baseDomain={site.baseDomain} error={firstParam(params.error)} />;
  return (
    <main className="mx-auto flex min-h-screen max-w-4xl flex-col justify-center px-6 py-16 sm:px-12">
      <p className="mb-12 text-sm font-semibold tracking-[0.25em] text-teal-800">MODULYN</p>
      <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-6xl">Основа для вашей CRM.</h1>
      <p className="mt-6 max-w-xl text-lg leading-8 text-slate-600">Одна платформа для независимых команд. Пользователи, данные и модули каждой компании — в своём пространстве.</p>
    </main>
  );
}
