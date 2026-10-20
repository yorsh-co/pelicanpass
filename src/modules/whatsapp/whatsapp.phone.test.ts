import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toE164 } from './whatsapp.phone.ts';

const ok = (e164: string) => ({ ok: true, e164 });
const refused = (reason: string) => ({ ok: false, reason });

describe('toE164 without a plus', () => {
  it('prefixes 10 and 11 digit numbers', () => {
    assert.deepEqual(toE164('1134567890', '55'), ok('551134567890'));
    assert.deepEqual(toE164('11912345678', '55'), ok('5511912345678'));
  });

  it('passes 12 and 13 digit numbers starting with the country code', () => {
    assert.deepEqual(toE164('551134567890', '55'), ok('551134567890'));
    assert.deepEqual(toE164('5511912345678', '55'), ok('5511912345678'));
  });

  it('tolerates punctuation', () => {
    assert.deepEqual(toE164('(11) 91234-5678', '55'), ok('5511912345678'));
  });

  it('refuses an empty value', () => {
    assert.deepEqual(toE164('', '55'), refused('empty'));
    assert.deepEqual(toE164('  ', '55'), refused('empty'));
  });

  it('refuses 9 and 14 digits as length', () => {
    assert.deepEqual(toE164('123456789', '55'), refused('length'));
    assert.deepEqual(toE164('55119123456789', '55'), refused('length'));
  });

  it('refuses an implausible area code as ddd', () => {
    assert.deepEqual(toE164('0912345678', '55'), refused('ddd'));
    assert.deepEqual(toE164('5501912345678', '55'), refused('ddd'));
  });

  it('refuses a qualified number from another country as unqualified', () => {
    assert.deepEqual(toE164('447911123456', '55'), refused('unqualified'));
  });
});

describe('toE164 with a plus and a foreign country code', () => {
  it('accepts a UK number', () => {
    assert.deepEqual(toE164('+44 7911 123456', '55'), ok('447911123456'));
  });

  it('accepts a US number', () => {
    assert.deepEqual(toE164('+1 212 555 1234', '55'), ok('12125551234'));
  });

  it('accepts up to 15 digits', () => {
    assert.deepEqual(toE164('+123456789012345', '55'), ok('123456789012345'));
  });

  it('refuses 16 digits as length', () => {
    assert.deepEqual(toE164('+1234567890123456', '55'), refused('length'));
  });

  it('refuses 9 digits as length', () => {
    assert.deepEqual(toE164('+123456789', '55'), refused('length'));
  });

  it('tolerates leading whitespace before the plus', () => {
    assert.deepEqual(toE164('  +447911123456', '55'), ok('447911123456'));
  });
});

describe('toE164 with a plus and the default country code', () => {
  it('accepts a qualified Brazilian number without prefixing again', () => {
    assert.deepEqual(toE164('+55 11 91234-5678', '55'), ok('5511912345678'));
  });

  it('refuses an implausible area code as ddd', () => {
    assert.deepEqual(toE164('+55 01 91234-5678', '55'), refused('ddd'));
  });

  it('refuses 10 and 11 digits as length', () => {
    assert.deepEqual(toE164('+55 3456-7890', '55'), refused('length'));
    assert.deepEqual(toE164('+55 91234-5678', '55'), refused('length'));
  });
});

describe('toE164 with nothing to read', () => {
  it('refuses a lone plus as empty', () => {
    assert.deepEqual(toE164('+', '55'), refused('empty'));
    assert.deepEqual(toE164(' + ', '55'), refused('empty'));
  });
});
