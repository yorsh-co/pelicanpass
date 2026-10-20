import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatTicket,
  isValidTicketCode,
  TICKET_CODE_LENGTH,
  TICKET_CODE_PATTERN,
  TICKET_INPUT_PATTERN,
  ticketPrefixKind,
  VOLUNTEER_TICKET_PREFIX,
  WALK_IN_TICKET_PREFIX,
} from './ticket.ts';

describe('formatTicket', () => {
  it('follows a code keystroke by keystroke', () => {
    const typed = ['x', 'xa', 'xab', 'xabc', 'xabc1', 'xabc12'];

    for (const value of typed) {
      assert.equal(formatTicket(value), value);
    }
  });

  it('lowercases and strips characters a code cannot hold', () => {
    assert.equal(formatTicket('XABC12'), 'xabc12');
    assert.equal(formatTicket('VABC12'), 'vabc12');
    assert.equal(formatTicket(' ab c_d!'), 'abcd');
  });

  it('strips hyphens wherever they fall', () => {
    assert.equal(formatTicket('x-abc12'), 'xabc12');
    assert.equal(formatTicket('-xabc12'), 'xabc12');
    assert.equal(formatTicket('x--abc1'), 'xabc1');
    assert.equal(formatTicket('xa-bc-12'), 'xabc12');
    assert.equal(formatTicket('x-'), 'x');
    assert.equal(formatTicket('-'), '');
  });

  it('caps every code at the code length', () => {
    assert.equal(TICKET_CODE_LENGTH, 6);
    assert.equal(formatTicket('xabc12z'), 'xabc12');
    assert.equal(formatTicket('abcdefghij'), 'abcdef');
    assert.equal(formatTicket('x-abc12q'), 'xabc12');
  });

  it('produces valid codes from well-formed input', () => {
    for (const code of ['xabc12', '000000', 'vabc12', 'XABC12', 'x-abc12']) {
      assert.ok(isValidTicketCode(formatTicket(code)), code);
    }
  });

  it('leaves valid codes unchanged', () => {
    for (const code of ['xabc12', '123456', 'vabc12', 'dabc12', 'z00000']) {
      assert.equal(formatTicket(code), code);
    }
  });
});

describe('isValidTicketCode', () => {
  it('accepts six alphanumerics under any key', () => {
    for (const code of [
      'vabc12',
      'dabc12',
      'xabc12',
      '7abc12',
      '123456',
      'abcdef',
      'z00000',
    ]) {
      assert.equal(isValidTicketCode(code), true, code);
    }
  });

  it('rejects codes that are not six characters', () => {
    for (const code of ['', 'a', 'abc1', 'xabc1', 'xabc123', 'abcdefgh']) {
      assert.equal(isValidTicketCode(code), false, code);
    }
  });

  it('rejects the hyphenated form', () => {
    for (const code of ['x-abc1', 'x-abc12', 'xabc-1', '-xabc12', 'xabc12-']) {
      assert.equal(isValidTicketCode(code), false, code);
    }
  });

  it('rejects symbols, whitespace and uppercase', () => {
    for (const code of [
      'xabc_2',
      'xabc 2',
      'xabc1!',
      ' xabc12',
      'Xabc12',
      'XABC12',
      'VABC12',
    ]) {
      assert.equal(isValidTicketCode(code), false, code);
    }
  });
});

describe('ticket code pattern', () => {
  it('is the pattern the input element receives', () => {
    assert.equal(TICKET_INPUT_PATTERN, TICKET_CODE_PATTERN);
  });

  it('matches the validator when the browser anchors it', () => {
    const anchored = new RegExp(`^(?:${TICKET_INPUT_PATTERN})$`);

    for (const code of ['xabc12', 'x-abc12', 'xabc123', 'XABC12']) {
      assert.equal(anchored.test(code), isValidTicketCode(code), code);
    }
  });
});

describe('ticketPrefixKind', () => {
  it('recognises the key the attendees editor generates', () => {
    assert.equal(ticketPrefixKind(WALK_IN_TICKET_PREFIX), 'generated');
    assert.equal(ticketPrefixKind('d'), 'generated');
  });

  it('treats every other key as an external source', () => {
    for (const prefix of ['x', 'a', 'p', 'v', '7', '0']) {
      assert.equal(ticketPrefixKind(prefix), 'external', prefix);
    }
  });
});

describe('reserved keys', () => {
  it('are one character and form valid codes with a five-character body', () => {
    for (const prefix of [VOLUNTEER_TICKET_PREFIX, WALK_IN_TICKET_PREFIX]) {
      assert.equal(prefix.length, 1, prefix);
      assert.equal(isValidTicketCode(`${prefix}abc12`), true, prefix);
    }
  });

  it('are distinct', () => {
    assert.notEqual(VOLUNTEER_TICKET_PREFIX, WALK_IN_TICKET_PREFIX);
  });
});
