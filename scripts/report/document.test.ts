import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ECHARTS_URL,
  escapeJson,
  labelToText,
  renderDocument,
  renderFragment,
  toQuestions,
} from './document.ts';

import { THEME_STORAGE_KEY } from './core/model.ts';

import type { ReportPayload } from './core/model.ts';

const payload: ReportPayload = {
  definitions: { participant: [], volunteer: null },
  hostChurch: null,
  data: null,
};

describe('ECHARTS_URL', () => {
  it('loads the version pinned in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { devDependencies: Record<string, string> };

    assert.ok(
      ECHARTS_URL.includes(`/echarts@${pkg.devDependencies.echarts ?? ''}/`),
    );
  });
});

describe('escapeJson', () => {
  it('escapes characters that can break out of a script element', () => {
    const json = escapeJson({ text: '</script><!-- & \u2028 \u2029' });

    assert.doesNotMatch(json, /[<>&\u2028\u2029]/);
    assert.deepEqual(JSON.parse(json), {
      text: '</script><!-- & \u2028 \u2029',
    });
  });
});

describe('labelToText', () => {
  it('strips tags and decodes entities', () => {
    assert.equal(
      labelToText(
        'Voc&ecirc; <strong>gostou</strong> de &quot;A &amp; B&quot;? &#39;ok&#39; &#x41;',
      ),
      'Voc&ecirc; gostou de "A & B"? \'ok\' A',
    );
  });

  it('collapses whitespace and leaves unknown entities alone', () => {
    assert.equal(labelToText(' a\n  <em>b</em> &foo; '), 'a b &foo;');
  });
});

describe('toQuestions', () => {
  it('keeps id and type and makes the label plain text', () => {
    assert.deepEqual(
      toQuestions([
        { id: 'q', label: '<em>Oi</em> &amp; tchau', type: 'text' },
      ]),
      [{ id: 'q', label: 'Oi & tchau', type: 'text' }],
    );
  });
});

describe('renderFragment', () => {
  const fragment = renderFragment({
    css: 'body{}',
    script: 'var a="</script>";',
    payload,
  });

  it('starts with the title and viewport hint and has no document tags', () => {
    assert.ok(fragment.startsWith('<title>Relatório PelicanPass</title>\n'));
    assert.match(fragment, /claude:viewport-fit-sides/);
    assert.doesNotMatch(fragment, /<(!doctype|html|head|body)/i);
  });

  it('loads ECharts before the bundle and keeps the script element intact', () => {
    assert.ok(fragment.indexOf('echarts.min.js') < fragment.indexOf('var a='));
    assert.equal(fragment.match(/<\/script>/g)?.length, 4);
  });

  it('applies a stored theme before ECharts loads', () => {
    const boot = fragment.indexOf(
      `localStorage.getItem("${THEME_STORAGE_KEY}")`,
    );

    assert.ok(boot !== -1);
    assert.ok(boot < fragment.indexOf('echarts.min.js'));
  });
});

describe('renderDocument', () => {
  it('wraps a fragment with charset and viewport', () => {
    const document = renderDocument('<p>x</p>\n');

    assert.match(document, /^<!doctype html>\n<html lang="pt-BR">/);
    assert.match(document, /<meta charset="utf-8">/);
    assert.match(document, /name="viewport"/);
    assert.match(document, /<body>\n<p>x<\/p>/);
  });
});
