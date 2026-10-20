import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  readOption,
  readPhone,
  readTypedTicketCode,
  readVolunteerOnlyOption,
} from './admin.attendees.rules.ts';
import { ITEM_OPTIONS, optionsFor } from './admin.item-options.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

import type { RedemptionItem } from '../../constants/pass.ts';

const ITEMS = Object.keys(ITEM_OPTIONS) as RedemptionItem[];

/** An item and value approved for volunteers and for participants alike. */
const shared = ITEMS.flatMap((item) =>
  optionsFor(item, 'participant')
    .filter((value) => optionsFor(item, 'volunteer').includes(value))
    .map((value) => ({ item, value })),
)[0];

const LUNCH = optionsFor('lunch', 'volunteer')[0] ?? '';
const OFF_LIST = 'not-on-any-list';

const refusedAs = (reason: string) => (err: unknown) =>
  err instanceof ValidationError &&
  err.statusCode === 400 &&
  err.details?.reason === reason;

describe('readOption', () => {
  it('accepts an approved value', () => {
    assert.ok(shared);
    assert.equal(
      readOption(shared.value, shared.item, 'participant', null),
      shared.value,
    );
  });

  it('reads empty and omitted values as none', () => {
    assert.ok(shared);
    assert.equal(readOption('  ', shared.item, 'participant', null), null);
    assert.equal(readOption(undefined, shared.item, 'participant', null), null);
  });

  it('refuses a new value that is not approved', () => {
    assert.ok(shared);
    assert.throws(
      () => readOption(OFF_LIST, shared.item, 'participant', null),
      refusedAs('optionNotAllowed'),
    );
  });

  it('refuses a value approved only for the other role', () => {
    assert.throws(
      () => readOption(LUNCH, 'lunch', 'participant', null),
      refusedAs('optionNotAllowed'),
    );
  });

  it('keeps an unchanged off-list value while the role is unchanged', () => {
    assert.ok(shared);
    assert.equal(
      readOption(OFF_LIST, shared.item, 'participant', {
        value: OFF_LIST,
        role: 'participant',
      }),
      OFF_LIST,
    );
  });

  it('refuses an unchanged value once the role changes and it is not approved', () => {
    assert.ok(shared);
    assert.throws(
      () =>
        readOption(OFF_LIST, shared.item, 'volunteer', {
          value: OFF_LIST,
          role: 'participant',
        }),
      refusedAs('optionNotAllowed'),
    );
  });

  it('keeps an unchanged value once the role changes if the new role approves it', () => {
    assert.ok(shared);
    assert.equal(
      readOption(shared.value, shared.item, 'volunteer', {
        value: shared.value,
        role: 'participant',
      }),
      shared.value,
    );
  });
});

describe('readOption with the meal roles', () => {
  const participantOnly = optionsFor('meal', 'participant').find(
    (value) => !optionsFor('meal', 'volunteer').includes(value),
  );

  it('has a meal approved for participants only', () => {
    assert.ok(participantOnly);
  });

  it('refuses it for a volunteer on create', () => {
    assert.ok(participantOnly);
    assert.throws(
      () => readOption(participantOnly, 'meal', 'volunteer', null),
      refusedAs('optionNotAllowed'),
    );
  });

  it('refuses a stored participant meal after a change to volunteer', () => {
    assert.ok(participantOnly);
    assert.throws(
      () =>
        readOption(participantOnly, 'meal', 'volunteer', {
          value: participantOnly,
          role: 'participant',
        }),
      refusedAs('optionNotAllowed'),
    );
  });

  it('keeps it while the role is unchanged', () => {
    assert.ok(participantOnly);
    assert.equal(
      readOption(participantOnly, 'meal', 'participant', {
        value: participantOnly,
        role: 'participant',
      }),
      participantOnly,
    );
  });
});

describe('readVolunteerOnlyOption', () => {
  it('accepts an approved value on a volunteer', () => {
    assert.equal(
      readVolunteerOnlyOption(LUNCH, 'lunch', 'volunteer', null),
      LUNCH,
    );
  });

  it('refuses a value on a participant', () => {
    assert.throws(
      () =>
        readVolunteerOnlyOption(LUNCH, 'lunch', 'participant', {
          value: LUNCH,
          role: 'volunteer',
        }),
      refusedAs('volunteerOnlyItem'),
    );
  });

  it('reads empty as none on a participant', () => {
    assert.equal(
      readVolunteerOnlyOption('', 'lunch', 'participant', null),
      null,
    );
  });
});

describe('readTypedTicketCode', () => {
  it('pins v codes to the volunteer role', () => {
    assert.equal(readTypedTicketCode(' VABC12 ', 'volunteer'), 'vabc12');
    assert.throws(
      () => readTypedTicketCode('vabc12', 'participant'),
      refusedAs('ticketCodePrefix'),
    );
    assert.throws(
      () => readTypedTicketCode('xabc12', 'volunteer'),
      refusedAs('ticketCodePrefix'),
    );
  });

  it('treats every other key as an ordinary participant code', () => {
    for (const code of ['pabc12', '7abc12', 'dabc12']) {
      assert.equal(readTypedTicketCode(code, 'participant'), code);
    }
  });

  it('refuses the hyphenated form and other lengths', () => {
    for (const code of ['x-abc12', 'v-abc12', 'xabc1', 'xabc123']) {
      for (const role of ['participant', 'volunteer'] as const) {
        assert.throws(
          () => readTypedTicketCode(code, role),
          refusedAs('ticketCodeFormat'),
          `${role} ${code}`,
        );
      }
    }
  });
});

describe('readPhone', () => {
  it('keeps only the digits of a plain number', () => {
    assert.equal(readPhone('(11) 91234-5678'), '11912345678');
  });

  it('keeps the + of a number typed with one', () => {
    assert.equal(readPhone('+44 7911 123456'), '+447911123456');
  });

  it('keeps the + behind leading whitespace', () => {
    assert.equal(readPhone('  +44 7911 123456'), '+447911123456');
  });

  it('refuses a + with too few digits or none', () => {
    for (const raw of ['+', '+123']) {
      assert.throws(() => readPhone(raw), refusedAs('phoneInvalid'));
    }
  });

  it('refuses a + with more than 15 digits', () => {
    assert.throws(
      () => readPhone('+1234567890123456'),
      refusedAs('phoneInvalid'),
    );
  });

  it('refuses a plain number of 9 or 16 digits', () => {
    for (const raw of ['123456789', '1234567890123456']) {
      assert.throws(() => readPhone(raw), refusedAs('phoneInvalid'));
    }
  });
});
