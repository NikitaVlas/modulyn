// Unit-тесты разбора фильтров списка заявок (Phase 7, L2) — без базы данных.
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:local@localhost:5432/test',
  JWT_SECRET_TENANT: 't'.repeat(40), JWT_SECRET_APP: 'a'.repeat(40), JWT_SECRET_PLATFORM: 'p'.repeat(40), PLATFORM_TOTP_KEY: 'ab'.repeat(32),
});
const { parseFilters } = await import('../dist/leads/leads.controller.js');
const me = '0195f0a0-0000-7000-8000-00000000000a';

test('defaults: all statuses, newest first, first page of 25', () => {
  assert.deepEqual(parseFilters({}, me), { statuses: [], assignee: { kind: 'any' }, q: null, sort: 'created_desc', page: 1, pageSize: 25 });
});

test('filters are parsed; "me" becomes the current user', () => {
  const f = parseFilters({ status: 'NEW,CLOSED', assignee: 'me', q: '  anna ', sort: 'created_asc', page: '3', pageSize: '50' }, me);
  assert.deepEqual(f, { statuses: ['NEW', 'CLOSED'], assignee: { kind: 'user', userId: me }, q: 'anna', sort: 'created_asc', page: 3, pageSize: 50 });
  assert.deepEqual(parseFilters({ assignee: 'none' }, me).assignee, { kind: 'none' });
});

test('invalid parameters are refused, not silently ignored', () => {
  for (const q of [{ status: 'OPEN' }, { assignee: 'x' }, { sort: 'name' }, { page: '0' }, { page: '1.5' }, { pageSize: '10' }, { q: 'x'.repeat(101) }, { status: ['NEW', 'CLOSED'] }]) {
    assert.throws(() => parseFilters(q, me), e => e.getStatus() === 400, JSON.stringify(q));
  }
});
