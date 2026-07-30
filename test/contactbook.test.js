import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVCards, vcardsToOverrides } from '../core/contactbook.js';

const BOOK = [
  'BEGIN:VCARD', 'VERSION:3.0', 'FN:Mom',
  'TEL;type=CELL;type=VOICE;type=pref:8 950 136-93-17',
  'TEL;type=HOME:+7 (3952) 50-05-77', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:3.0', 'N:Whitfield;Sam;;;',
  'item1.TEL;type=CELL:+7 707 242-17-01', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:2.1',
  'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=D0=A1=D0=B5=D1=80=D0=B3=D0=B5=D0=B9',
  'TEL;CELL:+79149331358', 'END:VCARD',
].join('\r\n');

test('reads the vCard dialects phones actually export', () => {
  const cards = parseVCards(BOOK);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].name, 'Mom', 'plain FN');
  assert.equal(cards[1].name, 'Sam Whitfield', 'built from the structured N field');
  assert.equal(cards[2].name, 'Сергей', 'quoted-printable UTF-8, as vCard 2.1 writes non-Latin names');
  assert.equal(cards[1].phones[0], '+7 707 242-17-01', "Apple's item1. prefix is not part of the property");
});

test('imported numbers go through the same normalizer as filenames', () => {
  // This is the only reason matching works: the book writes "8 950 136-93-17"
  // while the archive holds "89501369317".
  const { pairs } = vcardsToOverrides(BOOK);
  assert.equal(new Map(pairs).get('+79501369317'), 'Mom');
});

test('one person with several numbers names all of them', () => {
  const byKey = new Map(vcardsToOverrides(BOOK).pairs);
  assert.equal(byKey.get('+73952500577'), 'Mom');
});

test('folded lines are unfolded before parsing', () => {
  const folded = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:A very long\r\n  name\r\nTEL:+15550001234\r\nEND:VCARD';
  assert.equal(parseVCards(folded)[0].name, 'A very long name');
});

test('a card with no phone cannot be matched and is skipped', () => {
  const noTel = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Nobody\r\nEND:VCARD';
  assert.equal(parseVCards(noTel).length, 0);
});
