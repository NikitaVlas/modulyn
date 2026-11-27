import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { translate } from '@modulyn/i18n';
import './globals.css';
import { BrandProvider } from '../components/brand';
import { I18nProvider } from '../i18n/client';
import { serverLocale } from '../i18n/server';
import { serverBrand } from '../lib/brand';

export async function generateMetadata(): Promise<Metadata> {
  return { title: serverBrand().name, description: translate(await serverLocale(), 'meta.description'), referrer: 'no-referrer' };
}

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await serverLocale();
  const { color, ...brand } = serverBrand();
  return (
    <html lang={locale} style={{ '--brand': color } as CSSProperties}>
      <body><BrandProvider brand={brand}><I18nProvider initial={locale}>{children}</I18nProvider></BrandProvider></body>
    </html>
  );
}
