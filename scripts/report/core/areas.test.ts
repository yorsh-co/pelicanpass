import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchAreas } from './areas.ts';

describe('matchAreas', () => {
  it('ignores case, accents and punctuation', () => {
    assert.deepEqual(matchAreas('logistica'), ['LOGÍSTICA']);
    assert.deepEqual(matchAreas('Check in'), ['CHECK-IN']);
    assert.deepEqual(matchAreas('  check-in!! '), ['CHECK-IN']);
  });

  it('prefers the longest name', () => {
    assert.deepEqual(matchAreas('Alimentação Backstage'), [
      'ALIMENTAÇÃO BACKSTAGE',
    ]);
    assert.deepEqual(matchAreas('alimentação e alimentação backstage'), [
      'ALIMENTAÇÃO',
      'ALIMENTAÇÃO BACKSTAGE',
    ]);
  });

  it('returns several areas for one answer', () => {
    assert.deepEqual(matchAreas('Arte / Técnica e Check-in'), [
      'ARTES',
      'CHECK-IN',
      'TÉCNICA',
    ]);
  });

  it('resolves aliases', () => {
    assert.deepEqual(matchAreas('checkin'), ['CHECK-IN']);
    assert.deepEqual(matchAreas('experiencia'), [
      'EXPERIÊNCIA DO PARTICIPANTE',
    ]);
    assert.deepEqual(matchAreas('show'), ['SHOW DO INTERVALO']);
    assert.deepEqual(matchAreas('socorros'), ['PRIMEIROS SOCORROS']);
    assert.deepEqual(matchAreas('backstage'), ['ALIMENTAÇÃO BACKSTAGE']);
    assert.deepEqual(matchAreas('voluntario'), ['VOLUNTÁRIOS']);
  });

  it('matches whole words only', () => {
    assert.deepEqual(matchAreas('artesanato'), []);
  });

  it('returns nothing for unknown or empty text', () => {
    assert.deepEqual(matchAreas('não sei'), []);
    assert.deepEqual(matchAreas(''), []);
  });
});
