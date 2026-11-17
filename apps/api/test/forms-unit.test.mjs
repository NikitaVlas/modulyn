// Unit-тесты сопоставления полей формы (Phase 8, W3–W5) — без базы данных.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { idempotencyKey, mapSubmission, mappingError } from '../dist/forms/mapping.js';

const NOVA = { extra: [{ field: 'program', label: 'Программа' }] };

test('the Nova trial form maps to a lead: names joined, program added to the message', () => {
  const r = mapSubmission({
    submissionId: 'a'.repeat(32), firstName: ' Anna ', lastName: 'Muster', email: 'Anna@Example.de', phone: '+49 171 000',
    program: 'Kinder 4–6', message: 'Kommt mit Tochter',
  }, NOVA);
  assert.deepEqual(r, { ok: true, lead: { name: 'Anna Muster', email: 'anna@example.de', phone: '+49 171 000', message: 'Программа: Kinder 4–6\nKommt mit Tochter' } });
});

test('standard field names work without mapping; renames and unknown fields', () => {
  assert.deepEqual(mapSubmission({ name: 'Ivan', phone: '123456', utm: 'x' }, null), { ok: true, lead: { name: 'Ivan', email: null, phone: '123456', message: null } });
  assert.deepEqual(mapSubmission({ fullName: 'Ivan', mail: 'i@x.de' }, { fields: { name: 'fullName', email: 'mail' } }).lead, { name: 'Ivan', email: 'i@x.de', phone: null, message: null });
});

test('validation: name and one contact required; format and length limits', () => {
  assert.deepEqual(mapSubmission({ email: 'a@b.de' }, null), { ok: false, field: 'name', reason: 'required' });
  assert.deepEqual(mapSubmission({ name: 'x' }, null), { ok: false, field: 'email', reason: 'contact_required' });
  assert.deepEqual(mapSubmission({ name: 'x', email: 'bad' }, null), { ok: false, field: 'email', reason: 'invalid' });
  assert.deepEqual(mapSubmission({ name: 'x', phone: 'call me' }, null), { ok: false, field: 'phone', reason: 'invalid' });
  assert.deepEqual(mapSubmission({ name: 'x'.repeat(201), phone: '123' }, null), { ok: false, field: 'name', reason: 'too_long' });
  assert.deepEqual(mapSubmission({ name: '   ', phone: '123' }, null), { ok: false, field: 'name', reason: 'required' });
  assert.equal(mapSubmission({ name: { evil: true }, phone: '123' }, null).ok, false, 'non-string values are ignored');
});

test('mapping configuration is validated', () => {
  assert.equal(mappingError(null), null);
  assert.equal(mappingError(NOVA), null);
  assert.notEqual(mappingError({ fields: { password: 'x' } }), null);
  assert.notEqual(mappingError({ fields: { name: 'bad name' } }), null);
  assert.notEqual(mappingError({ extra: [{ field: 'p', label: '' }] }), null);
  assert.notEqual(mappingError({ extra: Array.from({ length: 21 }, (_, i) => ({ field: 'f' + i, label: 'L' })) }), null);
  assert.notEqual(mappingError({ other: 1 }), null);
});

test('idempotency: the site key wins; otherwise a hash of the content per UTC day', () => {
  const lead = { name: 'A', email: 'a@b.de', phone: null, message: null };
  assert.equal(idempotencyKey('abcdefgh12', lead), 'id:abcdefgh12');
  const day1 = idempotencyKey(null, lead, new Date('2026-11-17T10:00:00Z'));
  assert.equal(idempotencyKey(null, lead, new Date('2026-11-17T23:00:00Z')), day1, 'same day — same key');
  assert.notEqual(idempotencyKey(null, lead, new Date('2026-11-18T00:01:00Z')), day1, 'next day — new key');
  assert.notEqual(idempotencyKey(null, { ...lead, message: 'x' }, new Date('2026-11-17T10:00:00Z')), day1);
});
