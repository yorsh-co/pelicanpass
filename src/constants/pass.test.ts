import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REDEEMED_CHIP_VISIBLE_MS,
  WELCOME_CUSTOM_PHASE,
  isChipShown,
  isWelcomeLinePhase,
  normaliseWelcomeText,
} from './pass.ts';

const NOW = Date.parse('2026-09-29T20:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('isChipShown', () => {
  it('hides a slot the attendee is not entitled to', () => {
    assert.equal(isChipShown(null, null, NOW), false);
  });

  it('shows a pending item, including one whose redemption was reset', () => {
    assert.equal(isChipShown('M - Preto', null, NOW), true);
  });

  it('shows a collected item within the hour', () => {
    assert.equal(isChipShown('M - Preto', ago(0), NOW), true);
    assert.equal(
      isChipShown('M - Preto', ago(REDEEMED_CHIP_VISIBLE_MS - 1_000), NOW),
      true,
    );
  });

  it('hides a collected item once the hour is up', () => {
    assert.equal(
      isChipShown('M - Preto', ago(REDEEMED_CHIP_VISIBLE_MS), NOW),
      false,
    );
    assert.equal(
      isChipShown('M - Preto', ago(REDEEMED_CHIP_VISIBLE_MS * 3), NOW),
      false,
    );
  });

  it('accepts a Date as well as an ISO string', () => {
    assert.equal(isChipShown('Água', new Date(NOW - 60_000), NOW), true);
    assert.equal(
      isChipShown('Água', new Date(NOW - REDEEMED_CHIP_VISIBLE_MS), NOW),
      false,
    );
  });

  it('keeps the chip when the timestamp cannot be parsed', () => {
    assert.equal(isChipShown('Água', 'not a date', NOW), true);
  });
});

describe('isWelcomeLinePhase', () => {
  it('accepts the built-in phases and the custom one', () => {
    assert.equal(isWelcomeLinePhase('survey'), true);
    assert.equal(isWelcomeLinePhase(WELCOME_CUSTOM_PHASE), true);
  });

  it('refuses anything else', () => {
    assert.equal(isWelcomeLinePhase('Custom'), false);
    assert.equal(isWelcomeLinePhase(undefined), false);
  });
});

describe('normaliseWelcomeText', () => {
  it('trims and collapses whitespace, newlines included', () => {
    assert.equal(
      normaliseWelcomeText('  Intervalo:\n\tlanche  no pátio! '),
      'Intervalo: lanche no pátio!',
    );
  });

  it('strips bidirectional overrides and zero-width characters', () => {
    assert.equal(normaliseWelcomeText('a\u202Eb\u200Bc'), 'abc');
    assert.equal(normaliseWelcomeText('\u202E'), '');
  });

  it('composes decomposed accents', () => {
    assert.equal(normaliseWelcomeText('pátio'), 'pátio');
  });
});
