import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFilename, parseProps } from '../core/parse.js';

test('reads every filename shape a recorder produces', () => {
  assert.deepEqual(parseFilename('phone_20191231-124849_15550001234.amr'), {
    source: 'phone', startedAt: '2019-12-31T12:48:49', rawContact: '15550001234',
  });
  // A leading underscore on the number: the first one is the separator.
  assert.equal(parseFilename('phone_20230311-103633__15550001234.amr').rawContact, '_15550001234');
  assert.equal(parseFilename('phone_20250102-170433.amr').rawContact, '');
  assert.equal(parseFilename('viber_20221005-143659_Mom.amr').source, 'viber');
  assert.equal(parseFilename('gmeet_20250926-120717_Team standup.amr').rawContact, 'Team standup');
});

test('timestamps stay naive local, never shifted to UTC', () => {
  // The recorder wrote phone-local time. Converting would move every date in the
  // archive, so the parsed value must be exactly what the name says.
  assert.equal(parseFilename('phone_20200101-000000_1.amr').startedAt, '2020-01-01T00:00:00');
});

test('rejects impossible dates rather than inventing one', () => {
  assert.equal(parseFilename('phone_20190231-124849_1.amr'), null, '31 February');
  assert.equal(parseFilename('phone_20191301-124849_1.amr'), null, 'month 13');
  assert.equal(parseFilename('phone_20191231-256849_1.amr'), null, 'hour 25');
  assert.equal(parseFilename('not-a-recording.amr'), null);
});

test('props metadata survives a round trip, and bad input does not throw', () => {
  const p = parseProps('{"duration":"40500","callee":"600","direction":"Outgoing"}');
  assert.deepEqual(
    { d: p.durationMs, c: p.callee, dir: p.direction },
    { d: 40500, c: '600', dir: 'Outgoing' },
  );
  assert.equal(parseProps('not json'), null);
  assert.equal(parseProps('{"direction":"Sideways"}').direction, null);
});
