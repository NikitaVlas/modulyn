import type { Metadata } from 'next';
import { translate } from '@modulyn/i18n';
import './globals.css';
import { I18nProvider } from '../i18n/client';
import { serverLocale } from '../i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  return { title: 'Modulyn', description: translate(await serverLocale(), 'meta.description'), referrer: 'no-referrer' };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await serverLocale();
  return <html lang={locale}><body><I18nProvider initial={locale}>{children}</I18nProvider></body></html>;
}
