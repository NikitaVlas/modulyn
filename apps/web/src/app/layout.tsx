import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Modulyn', description: 'Модульная CRM-платформа', referrer: 'no-referrer' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
