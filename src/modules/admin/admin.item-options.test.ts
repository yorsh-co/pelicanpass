import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ItemOptionsError, parseItemOptions } from './admin.item-options.ts';

import type { RedemptionItem } from '../../constants/pass.ts';

const FILE = 'options.md';

const DEFAULTS: Record<RedemptionItem, string> = {
  tshirt: '- P\n- M',
  meal: '- Sanduiche',
  drink: '- Agua',
  lunch: '- 12h',
  tshirt_volunteer: '- G',
};

/** A valid file, with the given sections' bodies replaced. */
const fixture = (
  overrides: Partial<Record<RedemptionItem, string>> = {},
): string =>
  (Object.keys(DEFAULTS) as RedemptionItem[])
    .map((item) => `## ${item}\n\n${overrides[item] ?? DEFAULTS[item]}\n`)
    .join('\n');

/** The problems the parser reports for a file. */
const problemsOf = (source: string): readonly string[] => {
  try {
    parseItemOptions(source, FILE);
  } catch (err) {
    if (err instanceof ItemOptionsError) return err.problems;
    throw err;
  }

  return [];
};

describe('parseItemOptions', () => {
  it('gives an untagged list to both roles', () => {
    const parsed = parseItemOptions(fixture(), FILE);

    assert.deepEqual(parsed.all.tshirt, ['P', 'M']);
    assert.deepEqual(parsed.byRole.participant.tshirt, ['P', 'M']);
    assert.deepEqual(parsed.byRole.volunteer.tshirt, ['P', 'M']);
  });

  it('puts the untagged list before a role subsection, in file order', () => {
    const parsed = parseItemOptions(
      fixture({
        meal: '- Todos\n\n### volunteer\n\n- 17h15\n\n### participant\n\n- Hamburguer',
      }),
      FILE,
    );

    assert.deepEqual(parsed.byRole.participant.meal, ['Todos', 'Hamburguer']);
    assert.deepEqual(parsed.byRole.volunteer.meal, ['Todos', '17h15']);
    assert.deepEqual(parsed.all.meal, ['Todos', '17h15', 'Hamburguer']);
  });

  it('accepts subsections alone', () => {
    const parsed = parseItemOptions(
      fixture({
        drink: '### participant\n\n- Suco\n\n### volunteer\n\n- Cafe',
      }),
      FILE,
    );

    assert.deepEqual(parsed.byRole.participant.drink, ['Suco']);
    assert.deepEqual(parsed.byRole.volunteer.drink, ['Cafe']);
  });

  it('accepts a role with no entry in a section', () => {
    const parsed = parseItemOptions(
      fixture({ drink: '### volunteer\n\n- Cafe' }),
      FILE,
    );

    assert.deepEqual(parsed.byRole.participant.drink, []);
    assert.deepEqual(parsed.all.drink, ['Cafe']);
  });

  it('serves a volunteer-only item to volunteers alone', () => {
    const parsed = parseItemOptions(
      fixture({ lunch: '- 12h\n\n### volunteer\n\n- 13h' }),
      FILE,
    );

    assert.deepEqual(parsed.byRole.participant.lunch, []);
    assert.deepEqual(parsed.byRole.volunteer.lunch, ['12h', '13h']);
    assert.deepEqual(parsed.all.lunch, ['12h', '13h']);
  });

  it('refuses a participant subsection under a volunteer-only item', () => {
    assert.deepEqual(
      problemsOf(fixture({ lunch: '### participant\n\n- 12h' })),
      [
        `${FILE}: "## lunch" / "### participant": is for participants, who cannot hold this item`,
      ],
    );
  });

  it('refuses a subsection that is not a role', () => {
    assert.deepEqual(problemsOf(fixture({ meal: '### staff\n\n- A' })), [
      `${FILE}: "## meal" / "### staff": "staff" is not a role; subsections are participant, volunteer`,
    ]);
  });

  it('refuses a role given twice', () => {
    assert.deepEqual(
      problemsOf(
        fixture({ meal: '### volunteer\n\n- A\n\n### volunteer\n\n- B' }),
      ),
      [`${FILE}: "## meal" / "### volunteer": is given twice`],
    );
  });

  it('refuses a subsection with no list', () => {
    assert.deepEqual(
      problemsOf(
        fixture({ meal: '- A\n\n### volunteer\n\n### participant\n\n- B' }),
      ),
      [`${FILE}: "## meal" / "### volunteer": has no list`],
    );
  });

  it('refuses a subsection with no list at the end of the section', () => {
    assert.deepEqual(problemsOf(fixture({ meal: '- A\n\n### volunteer' })), [
      `${FILE}: "## meal" / "### volunteer": has no list`,
    ]);
  });

  it('refuses a value repeated across the untagged list and a subsection', () => {
    assert.deepEqual(
      problemsOf(fixture({ meal: '- A\n\n### volunteer\n\n- A' })),
      [`${FILE}: "## meal" / "### volunteer": "A" is listed twice`],
    );
  });

  it('refuses a value repeated across subsections', () => {
    assert.deepEqual(
      problemsOf(
        fixture({ meal: '### participant\n\n- A\n\n### volunteer\n\n- A' }),
      ),
      [`${FILE}: "## meal" / "### volunteer": "A" is listed twice`],
    );
  });

  it('allows the same value in different sections', () => {
    assert.deepEqual(
      problemsOf(fixture({ meal: '- Agua', drink: '- Agua' })),
      [],
    );
  });

  it('refuses a second list in a subsection, naming it', () => {
    assert.deepEqual(
      problemsOf(fixture({ meal: '### volunteer\n\n- A\n\n---\n\n- B' })),
      [
        `${FILE}: "## meal" / "### volunteer": has a horizontal rule where only its list may go`,
        `${FILE}: "## meal" / "### volunteer": has more than one list`,
      ],
    );
  });

  it('refuses a list after a subsection that follows an untagged one', () => {
    assert.deepEqual(
      problemsOf(
        fixture({ meal: '- A\n\n### volunteer\n\n- B\n\n---\n\n- C' }),
      ),
      [
        `${FILE}: "## meal" / "### volunteer": has a horizontal rule where only its list may go`,
        `${FILE}: "## meal" / "### volunteer": has more than one list`,
      ],
    );
  });

  it('refuses a section with no options at all', () => {
    assert.deepEqual(problemsOf(fixture({ meal: '' })), [
      `${FILE}: "## meal": has no options`,
    ]);
  });

  it('refuses a level-3 heading before the first section', () => {
    assert.deepEqual(problemsOf(`### volunteer\n\n${fixture()}`), [
      `${FILE}: has a level-3 heading before the first "##" section`,
    ]);
  });

  it('refuses other heading depths inside a section', () => {
    assert.deepEqual(problemsOf(fixture({ meal: '- A\n\n#### x' })), [
      `${FILE}: "## meal": has a level-4 heading where only its list may go`,
    ]);
  });

  it('collects every problem', () => {
    assert.equal(
      problemsOf(
        fixture({
          meal: '### staff\n\n- A',
          drink: '### volunteer\n\n### volunteer\n\n- B',
        }),
      ).length,
      3,
    );
  });

  it('freezes what it returns', () => {
    const parsed = parseItemOptions(fixture(), FILE);

    assert.ok(Object.isFrozen(parsed));
    assert.ok(Object.isFrozen(parsed.all));
    assert.ok(Object.isFrozen(parsed.byRole.volunteer));
    assert.ok(Object.isFrozen(parsed.byRole.volunteer.meal));
  });
});
