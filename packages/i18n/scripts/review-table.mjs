// Phase 10 (I7): таблица всех фраз для проверки носителем языка — docs/i18n/review.md.
// Запуск: pnpm --filter @modulyn/i18n build && node packages/i18n/scripts/review-table.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SECTIONS } from '../dist/index.js';

const out = fileURLToPath(new URL('../../../docs/i18n/review.md', import.meta.url));
const cell = s => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const TITLES = {
  common: 'Общее, навигация, ошибки связи', account: 'Вход, пароль, второй фактор, приглашение', crm: 'CRM: главная, заявки, сотрудники',
  intake: 'Приём заявок с сайтов', platform: 'Администрирование платформы', server: 'Сообщения сервера, служебные страницы, письма',
};
let md = `# Переводы Modulyn — проверка носителем языка

Сгенерировано из словаря \`packages/i18n\` (Phase 10). Немецкий — язык по умолчанию (обращение «Sie»), английский — британские форматы дат.
Как проверять: прочитайте столбец **Deutsch** (и при желании **English**); исправления присылайте с ключом из первого столбца.
Подстановки в фигурных скобках (\`{name}\`) — имена, числа, адреса; их не переводят.

Всего фраз: ${Object.values(SECTIONS).reduce((n, s) => n + Object.keys(s).length, 0)}.
`;
for (const [section, entries] of Object.entries(SECTIONS)) {
  md += `\n## ${TITLES[section] ?? section}\n\n| Ключ | Deutsch | English | Русский |\n|---|---|---|---|\n`;
  for (const [key, e] of Object.entries(entries)) md += `| \`${key}\` | ${cell(e.de)} | ${cell(e.en)} | ${cell(e.ru)} |\n`;
}
mkdirSync(fileURLToPath(new URL('../../../docs/i18n/', import.meta.url)), { recursive: true });
writeFileSync(out, md, 'utf8');
console.log(`written ${out}`);
