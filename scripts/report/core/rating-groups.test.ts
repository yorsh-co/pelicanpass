import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { RATING_GROUPS, groupRatings } from './rating-groups.ts';

import type { RatingStat } from './metrics.ts';

const stat = (id: string, mean: number | null, n = 5): RatingStat => ({
  id,
  label: id,
  n,
  mean,
  distribution: Array.from({ length: 10 }, () => 0),
});

describe('RATING_GROUPS', () => {
  it('maps every rating question of the participant survey', () => {
    const lines = readFileSync(
      new URL(
        '../../../src/web/content/pt-BR/survey-participant.md',
        import.meta.url,
      ),
      'utf8',
    ).split('\n');
    const ids = lines.flatMap((line, i) =>
      line.startsWith('- id: ') && lines[i + 1]?.trim() === '- type: rating'
        ? [line.slice('- id: '.length).trim()]
        : [],
    );

    assert.ok(ids.includes('overall_rating'));
    assert.ok(ids.length > 1);
    assert.deepEqual(
      ids.filter(
        (id) => id !== 'overall_rating' && !Object.hasOwn(RATING_GROUPS, id),
      ),
      [],
    );
  });
});

describe('groupRatings', () => {
  it('splits by group and ranks each best first', () => {
    const grouped = groupRatings([
      stat('food_rating', 7),
      stat('programme_rating', 8),
      stat('checkin_rating', 9),
      stat('venue_rating', 9.5),
    ]);

    assert.deepEqual(
      grouped.attractions.map((s) => s.id),
      ['programme_rating'],
    );
    assert.deepEqual(
      grouped.structure.map((s) => s.id),
      ['venue_rating', 'checkin_rating', 'food_rating'],
    );
    assert.deepEqual(grouped.other, []);
  });

  it('leaves out the overall score and unanswered questions', () => {
    const grouped = groupRatings([
      stat('overall_rating', 9),
      stat('food_rating', null, 0),
      stat('new_rating', null, 0),
    ]);

    assert.deepEqual(grouped, { attractions: [], structure: [], other: [] });
  });

  it('collects unmapped questions in other', () => {
    const grouped = groupRatings([
      stat('new_rating', 6),
      stat('food_rating', 5),
    ]);

    assert.deepEqual(
      grouped.other.map((s) => s.id),
      ['new_rating'],
    );
    assert.equal(grouped.structure.length, 1);
  });

  it('does not treat inherited object keys as mapped', () => {
    assert.equal(groupRatings([stat('toString', 5)]).other.length, 1);
  });
});
