import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const VIEWS = fileURLToPath(new URL('.', import.meta.url));

const templates = readdirSync(VIEWS, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ejs'))
  .map((file) => ({
    file,
    source: readFileSync(join(VIEWS, file), 'utf8'),
  }));

describe('views and the style-src policy', () => {
  it('finds the templates', () => {
    assert.ok(templates.length > 30);
  });

  it('carry no inline style attribute', () => {
    const offenders = templates
      .filter(({ source }) => /\sstyle\s*=/i.test(source))
      .map(({ file }) => file);

    assert.deepEqual(offenders, []);
  });

  it('give every <style> block the response nonce', () => {
    const offenders = templates
      .filter(({ source }) =>
        /<style\b(?![^>]*\snonce="<%= cspNonce %>")/i.test(source),
      )
      .map(({ file }) => file);

    assert.deepEqual(offenders, []);
  });
});
