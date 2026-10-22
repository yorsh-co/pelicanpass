import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { NOTICES } from './notices.ts';

const NOTICE_FILES = [
  ['privacy', 'privacy-notice.md', '/privacy'],
  ['terms', 'terms-of-use.md', '/terms'],
] as const;

const read = (locale: string, file: string): string =>
  readFileSync(new URL(`./${locale}/${file}`, import.meta.url), 'utf8');

describe('English notices', () => {
  for (const [key, file, path] of NOTICE_FILES) {
    it(`serves its own ${key} text, not the pt-BR fallback`, () => {
      assert.notEqual(NOTICES.en[key], NOTICES['pt-BR'][key]);
    });

    it(`links the ${key} courtesy note to the pt-BR page`, () => {
      assert.ok(
        NOTICES.en[key].includes(`<a href="${path}?lang=pt-BR">`),
        `${file} has no rendered link to ${path}?lang=pt-BR`,
      );
    });

    it(`keeps the ${key} headings, placeholders and links of pt-BR`, () => {
      const headings = (text: string) => text.match(/^#{1,6} /gm) ?? [];
      const markers = (text: string) =>
        (text.match(/\[[A-ZÇÃ]{3,}[A-ZÇÃ ]*\]|\{\w+\}/g) ?? []).sort();
      const targets = (text: string) =>
        [...text.matchAll(/\]\((https?:\/\/[^)]+|\/[^)?]*)\)/g)].map(
          (match) => match[1],
        );

      const en = read('en', file);
      const ptBR = read('pt-BR', file);

      assert.deepEqual(headings(en), headings(ptBR));
      assert.deepEqual(markers(en), markers(ptBR));
      assert.deepEqual(targets(en).sort(), targets(ptBR).sort());
    });
  }
});
