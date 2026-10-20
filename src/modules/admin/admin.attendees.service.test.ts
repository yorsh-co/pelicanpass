import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { generateTicketCode } from './admin.attendees.service.ts';
import {
  isValidTicketCode,
  TICKET_CODE_LENGTH,
  VOLUNTEER_TICKET_PREFIX,
  WALK_IN_TICKET_PREFIX,
} from '../../constants/ticket.ts';

/** Every character a generated code body may hold: no vowels, 0, 1, 3 or 4. */
const GENERATED_ALPHABET = 'bcdfghjklmnpqrstvwxyz256789';

describe('generateTicketCode', () => {
  it('gives participants a walk-in code', () => {
    for (let run = 0; run < 50; run += 1) {
      const code = generateTicketCode('participant');

      assert.ok(code.startsWith(WALK_IN_TICKET_PREFIX), code);
      assert.equal(code.length, TICKET_CODE_LENGTH);
      assert.ok(isValidTicketCode(code), code);
    }
  });

  it('gives volunteers a volunteer code', () => {
    for (let run = 0; run < 50; run += 1) {
      const code = generateTicketCode('volunteer');

      assert.ok(code.startsWith(VOLUNTEER_TICKET_PREFIX), code);
      assert.equal(code.length, TICKET_CODE_LENGTH);
      assert.ok(isValidTicketCode(code), code);
    }
  });

  for (const role of ['participant', 'volunteer'] as const) {
    it(`never puts a vowel, 0, 1, 3 or 4 in a ${role} code, and uses the whole alphabet`, () => {
      const seen = new Set<string>();

      for (let run = 0; run < 10_000; run += 1) {
        const code = generateTicketCode(role);
        const body = code.slice(1);

        assert.equal(code.length, TICKET_CODE_LENGTH);
        assert.ok(isValidTicketCode(code), code);
        assert.doesNotMatch(body, /[01aeiou34]/, code);

        for (const character of body) {
          assert.ok(GENERATED_ALPHABET.includes(character), code);
          seen.add(character);
        }
      }

      assert.deepEqual([...seen].sort(), GENERATED_ALPHABET.split('').sort());
    });
  }
});
