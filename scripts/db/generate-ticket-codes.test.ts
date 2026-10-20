import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateTicketCodes, parseArgs } from './generate-ticket-codes.ts';
import { isValidTicketCode } from '../../src/constants/ticket.ts';

const MAX_COUNT = 10_000;

describe('generateTicketCodes', () => {
  it('returns distinct, valid, vowel-free codes under the key', () => {
    const codes = generateTicketCodes(200, 'x');

    assert.equal(codes.length, 200);
    assert.equal(new Set(codes).size, 200);

    for (const code of codes) {
      assert.ok(isValidTicketCode(code), code);
      assert.ok(code.startsWith('x'), code);
      assert.doesNotMatch(code.slice(1), /[01aeiou34]/);
    }
  });

  it('defaults the key to a', () => {
    assert.ok(generateTicketCodes(5).every((code) => code.startsWith('a')));
  });

  it('accepts the volunteer key and a digit key', () => {
    assert.ok(generateTicketCodes(3, 'v').every((c) => c.startsWith('v')));
    assert.ok(generateTicketCodes(3, '7').every((c) => c.startsWith('7')));
  });

  it('refuses the walk-in key', () => {
    assert.throws(
      () => generateTicketCodes(1, 'd'),
      /"d" codes are issued by the attendees editor, not the roster/,
    );
  });

  it('refuses a key that is not one lowercase letter or digit', () => {
    for (const key of ['', 'ab', 'A', '-']) {
      assert.throws(() => generateTicketCodes(1, key), /key must be/, key);
    }
  });

  it('refuses a count outside 1 to the maximum', () => {
    for (const count of [0, -1, 1.5, NaN, MAX_COUNT + 1]) {
      assert.throws(
        () => generateTicketCodes(count),
        /count must be/,
        String(count),
      );
    }
  });

  it('accepts the maximum count with every code distinct', () => {
    const codes = generateTicketCodes(MAX_COUNT);

    assert.equal(new Set(codes).size, MAX_COUNT);
  });
});

describe('parseArgs', () => {
  it('reads the count and defaults the key', () => {
    assert.deepEqual(parseArgs(['10']), { count: 10, key: 'a' });
  });

  it('reads an explicit key', () => {
    assert.deepEqual(parseArgs(['3', 'v']), { count: 3, key: 'v' });
  });

  it('does not lowercase the key', () => {
    assert.deepEqual(parseArgs(['3', 'V']), { count: 3, key: 'V' });
  });

  it('refuses a count that is not a whole number', () => {
    for (const count of [
      '10abc',
      '',
      ' ',
      'abc',
      '1.5',
      '1e3',
      '0x10',
      ' 5',
      '-1',
    ]) {
      assert.throws(() => parseArgs([count]), /count must be/, count);
    }
  });

  it('refuses a missing count', () => {
    assert.throws(() => parseArgs([]), /expected a count/);
  });

  it('refuses extra arguments', () => {
    assert.throws(() => parseArgs(['1', 'a', 'b']), /expected a count/);
  });
});
