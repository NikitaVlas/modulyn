import { cookies } from 'next/headers';
import { LOCALE_COOKIE, toLocale, type Locale } from '@modulyn/i18n';

/** Язык для отрисовки на сервере (Phase 10): cookie переключателя, иначе немецкий (I3: браузер не угадываем). */
export async function serverLocale(): Promise<Locale> {
  return toLocale((await cookies()).get(LOCALE_COOKIE)?.value);
}
