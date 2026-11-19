// Phase 10 (I6, I10): словарь полный и согласованный во всех трёх языках.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOCALE, LOCALES, MESSAGE_ENTRIES, SECTIONS, formatDate, isLocale, placeholdersOf, toLocale, translate,
} from '../dist/index.js';

test('German is the default language; unknown values fall back to it', () => {
  assert.equal(DEFAULT_LOCALE, 'de');
  assert.deepEqual(LOCALES, ['de', 'en', 'ru']);
  assert.equal(toLocale('ru'), 'ru');
  assert.equal(toLocale('fr'), 'de');
  assert.equal(toLocale(undefined), 'de');
  assert.equal(isLocale('EN'), false, 'exact values only');
});

test('sections do not overwrite each other', () => {
  const total = Object.values(SECTIONS).reduce((n, s) => n + Object.keys(s).length, 0);
  assert.equal(Object.keys(MESSAGE_ENTRIES).length, total);
});

test('every phrase is filled in every language with the same placeholders', () => {
  const problems = [];
  for (const [key, entry] of Object.entries(MESSAGE_ENTRIES)) {
    for (const locale of LOCALES) {
      const text = entry[locale];
      if (typeof text !== 'string' || text.trim() === '' || text !== text.trim()) problems.push(`${key}: ${locale} empty or padded`);
    }
    const expected = placeholdersOf(entry.de).join(',');
    for (const locale of LOCALES) {
      if (placeholdersOf(entry[locale]).join(',') !== expected) problems.push(`${key}: ${locale} placeholders differ`);
    }
    for (const locale of ['de', 'en']) {
      if (/[А-Яа-яЁё]/.test(entry[locale])) problems.push(`${key}: Cyrillic in ${locale}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('translation and placeholders', () => {
  assert.equal(translate('de', 'tenant.welcome', { name: 'Anna' }), 'Willkommen, Anna');
  assert.equal(translate('en', 'leads.page', { page: 2, pages: 5 }), 'Page 2 of 5');
  assert.equal(translate('ru', 'leadStatus.NEW'), 'Новая');
  assert.equal(translate('de', 'leadStatus.CONVERTED'), 'Gewonnen');
  assert.equal(translate('de', 'role.MANAGER'), 'Mitarbeiter', 'glossary: Manager = Mitarbeiter');
  assert.equal(translate('en', 'tenant.welcome'), 'Welcome, {name}', 'missing parameter stays visible');
});

test('dates follow the language', () => {
  const d = new Date(Date.UTC(2026, 10, 19, 12, 0));
  assert.match(formatDate('de', d), /^19\.11\.2026$/);
  assert.match(formatDate('en', d), /^19\/11\/2026$/);
  assert.match(formatDate('ru', d), /^19\.11\.2026$/);
});
