// The normalizer is what makes a per-person view possible at all, so these cases
// are the ones that actually bit: one number written two ways, service short
// codes, and names that look like numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeContact } from '../core/contacts.js';

test('the same number in domestic and international form merges', () => {
  assert.equal(
    normalizeContact('89501369317').key,
    normalizeContact('_79501369317').key,
    'a trunk-prefixed number and its international form must reduce to one key',
  );
});

test('reduces to E.164', () => {
  assert.equal(normalizeContact('89501369317').key, '+79501369317');
  assert.equal(normalizeContact('_79501369317').key, '+79501369317');
  assert.equal(normalizeContact('+7 950 136-93-17').key, '+79501369317');
  assert.equal(normalizeContact('9501369317').key, '+79501369317');
});

test('a shared country code is not a special case', () => {
  // Kazakhstan sits inside +7; code plus subscriber length is all that matters.
  assert.equal(normalizeContact('_77476287837').key, '+77476287837');
});

test('service short codes stay verbatim', () => {
  for (const code of ['900', '600', '552689']) {
    const r = normalizeContact(code);
    assert.equal(r.kind, 'shortcode');
    assert.equal(r.key, code, 'a short code has no country and must not be rewritten');
  }
});

test('names are namespaced so they cannot collide with numbers', () => {
  assert.equal(normalizeContact('7').kind, 'shortcode');
  assert.match(normalizeContact('Mom').key, /^name:/);
});

test('an absent contact is explicit, not empty', () => {
  assert.equal(normalizeContact('').kind, 'unknown');
  assert.equal(normalizeContact(null, null).key, 'unknown');
});

test('the props sidecar supplies the contact when the filename has none', () => {
  assert.equal(normalizeContact('', '89501369317').key, '+79501369317');
});
