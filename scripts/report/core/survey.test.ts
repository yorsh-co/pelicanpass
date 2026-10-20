import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { followUpParents, parseSurveyCsv } from './survey.ts';

import type { Question } from './survey.ts';

const QUESTIONS: Question[] = [
  { id: 'rating', label: 'Nota geral', type: 'rating' },
  { id: 'would_return', label: 'Voltaria?', type: 'yes-no' },
  { id: 'comments', label: 'Comentário', type: 'text' },
  { id: 'removida', label: 'Fora do arquivo', type: 'rating' },
];

const csv = (...lines: string[]): string => `\uFEFF${lines.join('\r\n')}\r\n`;

describe('parseSurveyCsv', () => {
  it('parses typed answers, quoting and the formula guard', () => {
    const data = parseSurveyCsv(
      csv(
        'response_id,submitted_on,survey_version,rating,would_return,comments,other_answers',
        'a1,2026-10-18,v1,9,yes,"ótimo, ""mesmo""",{}',
        'a2,2026-10-19,v1,,no,\'=SUM(1),"{""x"":1}"',
      ),
      QUESTIONS,
    );

    assert.deepEqual(
      data.questions.map((q) => q.id),
      ['rating', 'would_return', 'comments'],
    );
    assert.deepEqual(data.responses, [
      {
        submittedOn: '2026-10-18',
        answers: { rating: 9, would_return: true, comments: 'ótimo, "mesmo"' },
      },
      {
        submittedOn: '2026-10-19',
        answers: { rating: null, would_return: false, comments: '=SUM(1)' },
      },
    ]);
    assert.ok(!JSON.stringify(data).includes('a1'));
  });

  it('infers the type of unknown columns', () => {
    const data = parseSurveyCsv(
      csv(
        'response_id,submitted_on,survey_version,n,s,t,e',
        'a,2026-10-18,v1,10,yes,oi,',
        'b,2026-10-18,v1,1,no,,',
      ),
      [],
    );

    assert.deepEqual(
      data.questions.map((q) => [q.id, q.label, q.type]),
      [
        ['n', 'n', 'rating'],
        ['s', 's', 'yes-no'],
        ['t', 't', 'text'],
        ['e', 'e', 'text'],
      ],
    );
  });

  it('infers text when a number is out of range', () => {
    const data = parseSurveyCsv(
      csv('response_id,submitted_on,survey_version,n', 'a,2026-10-18,v1,11'),
      [],
    );

    assert.equal(data.questions[0]?.type, 'text');
  });

  it('reads a file with no responses', () => {
    const data = parseSurveyCsv(
      csv('response_id,submitted_on,survey_version,rating'),
      QUESTIONS,
    );

    assert.deepEqual(data.responses, []);
    assert.equal(data.questions.length, 1);
  });

  it('refuses a file that is not a survey export', () => {
    assert.throws(
      () => parseSurveyCsv('a,b\n1,2\n', []),
      /Arquivo de pesquisa inválido: faltam as colunas response_id, submitted_on/,
    );
  });

  it('refuses a value that does not fit its question', () => {
    assert.throws(
      () =>
        parseSurveyCsv(
          csv('response_id,submitted_on,survey_version,rating', 'a,d,v,11'),
          QUESTIONS,
        ),
      /coluna rating, linha 2/,
    );
  });
});

describe('followUpParents', () => {
  const rating = (id: string): Question => ({ id, label: id, type: 'rating' });
  const yesNo = (id: string): Question => ({ id, label: id, type: 'yes-no' });
  const text = (id: string): Question => ({ id, label: id, type: 'text' });
  const parentIds = (questions: Question[]): [string, string][] =>
    [...followUpParents(questions)].map(([id, parent]) => [id, parent.id]);

  it('links <rating>_comment to the rating', () => {
    assert.deepEqual(
      parentIds([rating('overall_rating'), text('overall_rating_comment')]),
      [['overall_rating_comment', 'overall_rating']],
    );
  });

  it('links <yes-no>_comment to the yes-no', () => {
    assert.deepEqual(
      parentIds([yesNo('would_return'), text('would_return_comment')]),
      [['would_return_comment', 'would_return']],
    );
  });

  it('links why_not_invite to would_invite', () => {
    assert.deepEqual(
      parentIds([yesNo('would_invite'), text('why_not_invite')]),
      [['why_not_invite', 'would_invite']],
    );
  });

  it('leaves comments unlinked when there is no final question', () => {
    assert.deepEqual(
      parentIds([rating('overall_rating'), text('comments')]),
      [],
    );
  });

  it('does not follow a text question', () => {
    assert.deepEqual(parentIds([text('x'), text('x_comment')]), []);
  });

  it('ignores a table entry whose parent is absent', () => {
    assert.deepEqual(parentIds([text('why_not_invite')]), []);
  });

  it('does not treat a non-text _comment question as a follow-up', () => {
    assert.deepEqual(parentIds([rating('x'), rating('x_comment')]), []);
  });

  describe('questionnaire files', () => {
    const load = (file: string): Question[] => {
      const lines = readFileSync(
        new URL(`../../../src/web/content/pt-BR/${file}`, import.meta.url),
        'utf8',
      ).split('\n');

      return lines.flatMap((line, i): Question[] => {
        const type = lines[i + 1]?.trim().replace('- type: ', '');

        return line.startsWith('- id: ') &&
          (type === 'rating' || type === 'yes-no' || type === 'text')
          ? [{ id: line.slice('- id: '.length).trim(), label: '', type }]
          : [];
      });
    };

    it('leaves comments unlinked in the volunteer survey', () => {
      const questions = load('survey-volunteer.md');

      assert.ok(questions.some((q) => q.id === 'comments'));
      assert.equal(followUpParents(questions).has('comments'), false);
    });

    it('leaves every text question of the participant survey unlinked', () => {
      const questions = load('survey-participant.md');

      assert.ok(questions.some((q) => q.type === 'text'));
      assert.equal(followUpParents(questions).size, 0);
    });
  });
});
