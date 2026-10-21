import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LOCALES } from '../../i18n/locales.ts';
import {
  parseSurvey,
  sameStructure,
  surveyFor,
  SurveyDefinitionError,
} from './survey.definition.ts';

import type { SurveyQuestion } from '../../types/survey.ts';

const question = (label: string, hint = '') =>
  `## ${label}\n\n- id: q1\n- type: yes-no\n- required: yes\n\n${hint}\n`;

const file = (body: string, intro = 'Intro.') =>
  `# Title\n\n${intro}\n\n${body}`;

describe('parseSurvey links', () => {
  it('accepts http, https, mailto and relative links', () => {
    const parsed = parseSurvey(
      file(
        question(
          '[a](https://example.com)',
          '[b](mailto:x@example.com) [c](/privacy)',
        ),
        '[d](http://example.com)',
      ),
      'f.md',
    );

    assert.match(
      parsed.questions[0]?.label ?? '',
      /href="https:\/\/example.com"/,
    );
  });

  for (const target of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html;base64,AAAA',
    'vbscript:msgbox(1)',
  ]) {
    const scheme = (target.split(':')[0] ?? '').toLowerCase();

    for (const [where, source] of [
      ['title', `# [t](${target})\n\n${question('Q')}`],
      ['intro', file(question('Q'), `[i](${target})`)],
      ['label', file(question(`[l](${target})`))],
      ['hint', file(question('Q', `[h](${target})`))],
    ] as const) {
      it(`rejects a ${scheme} link in the ${where}`, () => {
        assert.throws(
          () => parseSurvey(source, 'f.md'),
          (error: unknown) =>
            error instanceof SurveyDefinitionError &&
            error.message.includes('link to a disallowed address'),
        );
      });
    }
  }
});

describe('sameStructure', () => {
  const base: SurveyQuestion[] = [
    { id: 'a', type: 'rating', required: true, label: 'A', hint: null },
    {
      id: 'b',
      type: 'text',
      required: false,
      label: 'B',
      hint: null,
      maxLength: 500,
    },
  ];

  it('accepts a translation that changes only the text', () => {
    const translated = base.map((q) => ({ ...q, label: 'X', hint: 'Y' }));

    assert.equal(sameStructure(base, translated), null);
  });

  it('names a changed id, type, required flag or max-length', () => {
    const [first, second] = base as [SurveyQuestion, SurveyQuestion];

    for (const changed of [
      [{ ...first, id: 'z' }, second],
      [{ ...first, type: 'yes-no' as const }, second],
      [{ ...first, required: false }, second],
      [first, { ...second, maxLength: 800 }],
    ]) {
      assert.match(sameStructure(base, changed) ?? '', /differs from pt-BR/);
    }
  });

  it('names a missing and an extra question', () => {
    const [first] = base as [SurveyQuestion, SurveyQuestion];

    assert.match(sameStructure(base, base.slice(0, 1)) ?? '', /is missing/);
    assert.match(
      sameStructure(base, [...base, { ...first, id: 'c' }]) ?? '',
      /which pt-BR does not/,
    );
  });
});

describe('surveyFor across locales', () => {
  for (const role of ['participant', 'volunteer'] as const) {
    it(`serves every locale the ${role} questions with pt-BR's ids, types, limits and versions`, () => {
      const base = surveyFor(role, 'pt-BR');

      assert.ok(base);

      for (const locale of LOCALES) {
        const served = surveyFor(role, locale);

        assert.ok(served, locale);
        assert.equal(served.version, base.version, locale);
        assert.equal(served.structureVersion, base.structureVersion, locale);
        assert.equal(sameStructure(base.questions, served.questions), null);
      }
    });

    it(`has its own English ${role} text, not the pt-BR fallback`, () => {
      const base = surveyFor(role, 'pt-BR');
      const english = surveyFor(role, 'en');

      assert.ok(base && english);
      assert.notEqual(english.title, base.title);

      for (const [index, question] of english.questions.entries()) {
        assert.notEqual(question.label, base.questions[index]?.label);
      }
    });
  }
});
