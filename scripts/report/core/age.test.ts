import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AGE_BANDS,
  UNKNOWN_AGE,
  AGE_DETAILS,
  ageBand,
  ageBandOf,
  ageDetail,
  bandOfDetail,
  ageLabel,
  normaliseAgeChoices,
  toggleAge,
} from './age.ts';

import type { Attendee } from './checkin.ts';

describe('ageBand', () => {
  it('places ages at the band boundaries', () => {
    assert.deepEqual([0, 12, 13, 18, 19, 120].map(ageBand), [
      '≤12',
      '≤12',
      '13–18',
      '13–18',
      '19+',
      '19+',
    ]);
  });

  it('defines exactly three bands in ascending order', () => {
    assert.deepEqual([...AGE_BANDS], ['≤12', '13–18', '19+']);
  });
});

describe('ageDetail', () => {
  it('keeps single years from 13 to 18 and collapses the rest', () => {
    assert.deepEqual([0, 12, 13, 14, 15, 16, 17, 18, 19, 120].map(ageDetail), [
      '≤12',
      '≤12',
      '13',
      '14',
      '15',
      '16',
      '17',
      '18',
      '19+',
      '19+',
    ]);
  });

  it('maps every detail to its filter range', () => {
    assert.deepEqual(AGE_DETAILS.map(bandOfDetail), [
      '≤12',
      '13–18',
      '13–18',
      '13–18',
      '13–18',
      '13–18',
      '13–18',
      '19+',
    ]);
  });

  it('reads the range of a registration', () => {
    assert.equal(ageBandOf({ ageDetail: '16' } as Attendee), '13–18');
    assert.equal(ageBandOf({ ageDetail: null } as Attendee), null);
  });
});

describe('toggleAge', () => {
  it('adds a choice that is not selected', () => {
    assert.deepEqual(toggleAge([], '13–18'), ['13–18']);
  });

  it('removes a choice that is selected', () => {
    assert.deepEqual(toggleAge(['≤12', '13–18'], '≤12'), ['13–18']);
  });

  it('keeps band order and puts the unknown choice last', () => {
    assert.deepEqual(toggleAge([UNKNOWN_AGE, '19+'], '≤12'), [
      '≤12',
      '19+',
      UNKNOWN_AGE,
    ]);
    assert.deepEqual(toggleAge(['19+'], '13–18'), ['13–18', '19+']);
  });

  it('does not mutate the selection', () => {
    const selected = ['13–18'] as const;

    toggleAge(selected, '≤12');
    assert.deepEqual(selected, ['13–18']);
  });
});

describe('ageLabel', () => {
  it('is null when nothing is selected', () => {
    assert.equal(ageLabel([]), null);
  });

  it('lists the selected bands without compressing them', () => {
    assert.equal(ageLabel(['≤12', '19+']), '≤12, 19+');
    assert.equal(ageLabel(['13–18']), '13–18');
    assert.equal(ageLabel(['≤12', '13–18', '19+']), '≤12, 13–18, 19+');
  });

  it('ignores the order of the input', () => {
    assert.equal(ageLabel(['19+', '≤12']), '≤12, 19+');
  });

  it('appends the unknown choice last', () => {
    assert.equal(ageLabel([UNKNOWN_AGE, '13–18']), `13–18, ${UNKNOWN_AGE}`);
    assert.equal(ageLabel([UNKNOWN_AGE]), UNKNOWN_AGE);
  });
});

describe('normaliseAgeChoices', () => {
  it('keeps valid choices of an array in canonical order', () => {
    assert.deepEqual(normaliseAgeChoices([UNKNOWN_AGE, '19+', '≤12']), [
      '≤12',
      '19+',
      UNKNOWN_AGE,
    ]);
  });

  it('drops invalid values and duplicates', () => {
    assert.deepEqual(
      normaliseAgeChoices(['13–18', '13–18', '20+', '14', '≤13', 7, null, {}]),
      ['13–18'],
    );
  });

  it('wraps a legacy single choice', () => {
    assert.deepEqual(normaliseAgeChoices('13–18'), ['13–18']);
    assert.deepEqual(normaliseAgeChoices(UNKNOWN_AGE), [UNKNOWN_AGE]);
  });

  it('discards legacy bands that no longer exist', () => {
    for (const old of ['≤13', '14', '15', '18', '19']) {
      assert.deepEqual(normaliseAgeChoices(old), []);
    }
    assert.deepEqual(normaliseAgeChoices('20+'), []);
  });

  it('returns an empty list for anything else', () => {
    for (const junk of [null, undefined, 15, {}, true, '']) {
      assert.deepEqual(normaliseAgeChoices(junk), []);
    }
  });
});
