import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergeSourceEdits } from './import-source.ts';

import type { Namespace } from '../../src/i18n/namespaces.ts';
import type { SourceMessage } from './generate.ts';

const catalogs = new Map<Namespace, Record<string, SourceMessage>>([
  [
    'raffle',
    {
      'raffle.idle': {
        defaultMessage: 'Toca em gerar para começar',
        description: 'Hint before the first draw.',
      },
      'raffle.drawn': {
        defaultMessage: '{count, plural, one {# gerado} other {# gerados}}',
        description: 'How many numbers were drawn.',
      },
      'raffle.water': {
        defaultMessage: "Copo d'água",
        description: 'An apostrophe.',
      },
    },
  ],
  [
    'staff',
    {
      'staff.greeting': {
        defaultMessage: 'Olá, {name}',
        description: 'Greeting.',
      },
      'staff.role': {
        defaultMessage:
          '{role, select, lead {Líder} helper {Ajudante} other {Equipe}}',
        description: 'Role label.',
      },
    },
  ],
]);

const unchanged = {
  'raffle.idle': 'Toca em gerar para começar',
  'raffle.drawn': '{count, plural, one {# gerado} other {# gerados}}',
  'raffle.water': "Copo d'água",
  'staff.greeting': 'Olá, {name}',
  'staff.role': '{role, select, lead {Líder} helper {Ajudante} other {Equipe}}',
};

describe('mergeSourceEdits', () => {
  it('changes nothing when the export matches the catalogs', () => {
    const result = mergeSourceEdits(catalogs, unchanged);

    assert.deepEqual(result, { updated: new Map(), absent: [], errors: [] });
  });

  it('updates the wording and keeps descriptions and key order', () => {
    const result = mergeSourceEdits(catalogs, {
      ...unchanged,
      'raffle.drawn': '{count, plural, =1 {Um gerado} other {# gerados}}',
      'staff.greeting': 'Oi, {name}!',
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual([...result.updated.keys()], ['raffle', 'staff']);

    const raffle = result.updated.get('raffle');

    assert.ok(raffle);
    assert.deepEqual(raffle.changed, ['raffle.drawn']);
    assert.deepEqual(Object.keys(raffle.catalog), [
      'raffle.idle',
      'raffle.drawn',
      'raffle.water',
    ]);
    assert.deepEqual(raffle.catalog['raffle.drawn'], {
      defaultMessage: '{count, plural, =1 {Um gerado} other {# gerados}}',
      description: 'How many numbers were drawn.',
    });
    assert.equal(
      result.updated.get('staff')?.catalog['staff.greeting']?.defaultMessage,
      'Oi, {name}!',
    );
  });

  it('does not mutate the catalogs it is given', () => {
    mergeSourceEdits(catalogs, {
      ...unchanged,
      'raffle.idle': 'Toca em gerar',
    });

    assert.equal(
      catalogs.get('raffle')?.['raffle.idle']?.defaultMessage,
      'Toca em gerar para começar',
    );
  });

  it('skips a change that only re-escapes the message', () => {
    const result = mergeSourceEdits(catalogs, {
      ...unchanged,
      'raffle.water': "Copo d''água",
    });

    assert.deepEqual(result.updated, new Map());
    assert.deepEqual(result.errors, []);
  });

  it('lists catalog IDs the export does not have', () => {
    const partial = Object.fromEntries(
      Object.entries(unchanged).filter(([id]) => id !== 'staff.role'),
    );
    const result = mergeSourceEdits(catalogs, partial);

    assert.deepEqual(result.absent, ['staff.role']);
    assert.deepEqual(result.errors, []);
  });

  it('refuses an unknown ID, an empty message and invalid ICU', () => {
    const result = mergeSourceEdits(catalogs, {
      ...unchanged,
      'raffle.unknown': 'Novo',
      'raffle.idle': '  ',
      'staff.greeting': 'Olá, {name',
    });

    assert.equal(result.errors.length, 3);
    assert.match(
      result.errors[0] ?? '',
      /^pt-BR\/raffle: raffle\.idle: empty$/,
    );
    assert.match(result.errors[1] ?? '', /^pt-BR\/staff: staff\.greeting: /);
    assert.match(result.errors[2] ?? '', /^raffle\.unknown: not in the pt-BR/);
  });

  it('refuses a renamed, dropped or retyped argument', () => {
    const result = mergeSourceEdits(catalogs, {
      ...unchanged,
      'raffle.drawn': '{count} gerados',
      'staff.greeting': 'Olá, {nome}',
      'raffle.idle': 'Toca em gerar, {name}',
    });

    assert.equal(result.errors.length, 3);

    for (const error of result.errors) {
      assert.match(error, /arguments differ/);
    }
  });

  it('refuses a select that gains or loses a case', () => {
    for (const role of [
      '{role, select, lead {Líder} other {Equipe}}',
      '{role, select, lead {Líder} helper {Ajudante} host {Anfitrião} other {Equipe}}',
    ]) {
      const result = mergeSourceEdits(catalogs, {
        ...unchanged,
        'staff.role': role,
      });

      assert.deepEqual(result.errors, [
        "pt-BR/staff: staff.role: arguments differ from the catalog's; change the message and its call sites by hand",
      ]);
    }
  });

  it('refuses a tag', () => {
    const result = mergeSourceEdits(catalogs, {
      ...unchanged,
      'raffle.idle': 'Toca em <b>gerar</b>',
    });

    assert.match(result.errors[0] ?? '', /tags are not supported/);
  });
});
