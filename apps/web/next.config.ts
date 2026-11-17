import type { NextConfig } from 'next';

/**
 * Заголовки безопасности страниц интерфейса (Phase 9.2, F2). API ставит свои через helmet, страницы Next.js — здесь.
 * - Встраивание в чужие сайты запрещено (защита от clickjacking: «Удалить заявку» в невидимом iframe).
 * - Referrer: только origin при переходе на другие сайты (не no-referrer: иначе формы перехода между поддоменами
 *   получили бы Origin: null).
 * Полная CSP для скриптов требует nonce в Next.js — отдельная задача после MVP.
 */
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
];

const config: NextConfig = {
  poweredByHeader: false,
  agentRules: false,
  allowedDevOrigins: ['*.localhost'],
  async rewrites() { return [{ source: '/api/:path*', destination: 'http://127.0.0.1:3001/api/:path*' }]; },
  async headers() { return [{ source: '/:path*', headers: SECURITY_HEADERS }]; },
};
export default config;
