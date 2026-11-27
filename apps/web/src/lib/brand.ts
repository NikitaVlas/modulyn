import type { BrandConfig } from '../components/brand';

/**
 * Бренд установки из окружения сервера (Phase 11, E4). Без настройки — Modulyn.
 * BRAND_NAME — название продукта (шапка, вход, вкладка браузера); BRAND_COLOR — #RRGGBB;
 * BRAND_LOGO_URL — путь на этом же сайте (/brand/logo.svg) или https-адрес. Неверные значения игнорируются.
 */
export function serverBrand(): BrandConfig & { color: string } {
  const name = (process.env.BRAND_NAME ?? '').trim().slice(0, 60) || 'Modulyn';
  const color = /^#[0-9a-f]{6}$/i.test(process.env.BRAND_COLOR ?? '') ? process.env.BRAND_COLOR! : '#115e59';
  const logo = (process.env.BRAND_LOGO_URL ?? '').trim();
  const logoUrl = /^\/[A-Za-z0-9._/-]+$/.test(logo) || /^https:\/\/[^\s"'<>]+$/.test(logo) ? logo : null;
  return { name, color, logoUrl };
}
