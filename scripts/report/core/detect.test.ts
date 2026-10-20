import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyCsv, parseUploads } from './detect.ts';
import { generateSampleCsv } from './sample.ts';

import type { Definitions } from './model.ts';

const definitions: Definitions = {
  participant: [
    { id: 'food_rating', label: 'Alimentação', type: 'rating' },
    { id: 'overall_rating', label: 'Geral', type: 'rating' },
  ],
  volunteer: [
    { id: 'volunteer_area', label: 'Área', type: 'text' },
    { id: 'overall_rating', label: 'Geral', type: 'rating' },
  ],
};
const sample = generateSampleCsv(definitions);

describe('classifyCsv', () => {
  it('recognises the check-in export', () => {
    assert.deepEqual(classifyCsv(sample.checkin, definitions), {
      kind: 'checkin',
    });
  });

  it('assigns a survey to the audience sharing most question ids', () => {
    assert.deepEqual(classifyCsv(sample.participant, definitions), {
      kind: 'survey',
      audience: 'participant',
    });
    assert.deepEqual(classifyCsv(sample.volunteer ?? '', definitions), {
      kind: 'survey',
      audience: 'volunteer',
    });
  });

  it('refuses a tie, no overlap and other files', () => {
    assert.throws(
      () =>
        classifyCsv('response_id,submitted_on,overall_rating\r\n', definitions),
      /público da pesquisa/,
    );
    assert.throws(
      () => classifyCsv('response_id,submitted_on,x\r\n', definitions),
      /público da pesquisa/,
    );
    assert.throws(
      () => classifyCsv('a,b\r\n1,2\r\n', definitions),
      /não reconhecido/,
    );
  });
});

describe('parseUploads', () => {
  const file = (name: string, text: string) => ({ name, text });

  it('parses files in any order', () => {
    const result = parseUploads(
      [
        file('v.csv', sample.volunteer ?? ''),
        file('c.csv', sample.checkin),
        file('p.csv', sample.participant),
      ],
      definitions,
    );

    assert.ok(result.attendees.length > 0);
    assert.equal(result.surveys.participant?.responses.length, 200);
    assert.equal(result.surveys.volunteer?.responses.length, 45);
  });

  it('accepts the check-in file alone', () => {
    const result = parseUploads([file('c.csv', sample.checkin)], definitions);

    assert.equal(result.surveys.participant, null);
  });

  it('requires a check-in file', () => {
    assert.throws(
      () => parseUploads([file('p.csv', sample.participant)], definitions),
      /Falta o arquivo de check-in/,
    );
  });

  it('refuses repeated kinds and names the file at fault', () => {
    assert.throws(
      () =>
        parseUploads(
          [file('a.csv', sample.checkin), file('b.csv', sample.checkin)],
          definitions,
        ),
      /^Error: b\.csv: Há mais de um arquivo de check-in/,
    );
  });
});
