// The filters here encode findings that cost real time to discover, so they are
// the ones most worth pinning down: a future "simplification" that breaks them
// would otherwise only show up as junk in the archive weeks later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterSegments, looksCollapsed } from '../core/transcribe.js';

const seg = (text, i = 0) => ({ t0: i * 1000, t1: i * 1000 + 900, text });

test('drops the subtitle credits whisper invents on noise', () => {
  const junk = [
    'Субтитры сделал DimaTorzok',
    'Спасибо за субтитры Алексею Дубровскому!',
    'Продолжение следует...',
    'Добро пожаловать в наш канал!',
    'Thanks for watching!',
    'Subtitles by someone',
    'Like and subscribe',
  ];
  const real = ['Алло, да, привет.', 'Как там на огороде?'];
  const r = filterSegments([...junk, ...real].map((t, i) => seg(t, i)));
  assert.equal(r.filtered, junk.length);
  assert.deepEqual(r.segments.map((s) => s.text), real);
});

test('keeps ordinary speech that merely mentions thanks or a channel', () => {
  const kept = filterSegments([seg('Спасибо, я перезвоню.'), seg('Да, конечно.')]);
  assert.equal(kept.filtered, 0);
});

test('collapses a repeated phrase into one, extending its span', () => {
  const r = filterSegments([seg('Звук', 0), seg('Звук', 1), seg('Звук', 2)]);
  assert.equal(r.segments.length, 1);
  assert.equal(r.segments[0].t1, 2900, 'the surviving segment must cover the whole run');
});

test('segments of pure punctuation are not speech', () => {
  assert.equal(filterSegments([seg('...'), seg('—')]).segments.length, 0);
});

test('recognizes the decode collapse by its shape', () => {
  const collapsed = 'кто там пищит до сейчас пытаюсь помнить там что-то короче как-то '
    + 'внешние данные да что-то внешние данные или как там есть что-нибудь такое или импорт';
  assert.equal(looksCollapsed([seg(collapsed)]), true);

  const healthy = 'Алло. Ой, это такое... reconnecting. Алло. Ага, да, что-то соединение, '
    + 'нет. Не сработало. Нет, я полы помыл и помылся. Так, а что, во сколько тогда?';
  assert.equal(looksCollapsed([seg(healthy)]), false);
});

test('refuses to judge a collapse from too few words', () => {
  // A short answer legitimately has no punctuation; calling it collapsed would
  // send healthy recordings through a pointless second pass.
  assert.equal(looksCollapsed([seg('алло да')]), false);
});
