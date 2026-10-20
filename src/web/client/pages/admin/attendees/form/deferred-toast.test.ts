import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_DURATION_MS, combineToast } from './deferred-toast.ts';

const EXCEEDED = 'Limite excedido (51 / 50).';

describe('combineToast', () => {
  it('returns null when there is nothing to show', () => {
    assert.equal(combineToast(null, null), null);
  });

  it('returns the primary toast unchanged without a warning', () => {
    const primary = { level: 'success', message: 'Salvo.' } as const;

    assert.deepEqual(combineToast(primary, null), {
      ...primary,
      duration: DEFAULT_DURATION_MS,
    });
  });

  it('shows the warning alone at warn level with the default duration', () => {
    assert.deepEqual(combineToast(null, EXCEEDED), {
      level: 'warn',
      message: EXCEEDED,
      duration: DEFAULT_DURATION_MS,
    });
  });

  it('joins the confirmation and the warning and extends the duration', () => {
    assert.deepEqual(
      combineToast({ level: 'success', message: 'Salvo.' }, EXCEEDED),
      {
        level: 'warn',
        message: `Salvo. ${EXCEEDED}`,
        duration: 8000,
      },
    );
  });

  for (const [from, to] of [
    ['success', 'warn'],
    ['info', 'warn'],
    ['debug', 'warn'],
    ['warn', 'warn'],
    ['error', 'error'],
  ] as const) {
    it(`turns a ${from} confirmation into ${to}`, () => {
      assert.equal(
        combineToast({ level: from, message: 'x' }, EXCEEDED)?.level,
        to,
      );
    });
  }
});
