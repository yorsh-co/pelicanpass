import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseSurvey, SurveyDefinitionError } from './survey.definition.ts';

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
