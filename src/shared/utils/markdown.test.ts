import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderMarkdown } from './markdown.ts';

describe('renderMarkdown', () => {
  it('escapes raw HTML blocks', () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\ntext');

    assert.doesNotMatch(html, /<script/i);
    assert.match(html, /&lt;script&gt;/);
  });

  it('escapes inline HTML, handlers included', () => {
    const html = renderMarkdown(
      'a <img src=x onerror=alert(1)> b <a onclick="alert(1)">c</a>',
    );

    assert.doesNotMatch(html, /<img/i);
    assert.doesNotMatch(html, /<a onclick/i);
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  it('renders only the text of a javascript: link', () => {
    const html = renderMarkdown('[x](javascript:alert(1))');

    assert.equal(html.trim(), '<p>x</p>');
  });

  it('refuses disguised schemes', () => {
    for (const href of [
      'JaVaScRiPt:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'vbscript:msgbox(1)',
      '&#106;avascript:alert(1)',
      'javascript&colon;alert(1)',
      '&#x6A;avascript:alert(1)',
      'java\tscript:alert(1)',
    ]) {
      const html = renderMarkdown(`[x](${href})`);

      assert.doesNotMatch(html, /<a\b/, href);
    }
  });

  it('refuses an autolink and a reference link with a bad scheme', () => {
    assert.doesNotMatch(renderMarkdown('<javascript:alert(1)>'), /<a\b/);
    assert.doesNotMatch(
      renderMarkdown('[x][r]\n\n[r]: javascript:alert(1)'),
      /<a\b/,
    );
  });

  it('keeps links that are relative or use http, https or mailto', () => {
    for (const href of [
      'https://example.com/a?b=1',
      'http://example.com',
      'mailto:dpo@example.com',
      '/privacy',
      '#section',
      'terms',
      '../terms',
    ]) {
      assert.match(
        renderMarkdown(`[x](${href})`),
        new RegExp(`<a href="${href.replace(/[.?]/g, '\\$&')}">x</a>`),
        href,
      );
    }
  });

  it('keeps a title on a safe link', () => {
    assert.match(
      renderMarkdown('[x](https://example.com "t")'),
      /<a href="https:\/\/example.com" title="t">x<\/a>/,
    );
  });

  it('renders an image only for a safe URL, else its alt text', () => {
    assert.match(
      renderMarkdown('![logo](/logo.png)'),
      /<img src="\/logo.png" alt="logo">/,
    );
    assert.equal(
      renderMarkdown('![logo](javascript:alert(1))').trim(),
      '<p>logo</p>',
    );
    assert.equal(
      renderMarkdown('![<b>](data:image/svg+xml;base64,AAAA)').trim(),
      '<p>&lt;b&gt;</p>',
    );
  });

  it('renders ordinary Markdown as before', () => {
    assert.equal(
      renderMarkdown('# T\n\n**b** and `c` & d').trim(),
      '<h1>T</h1>\n<p><strong>b</strong> and <code>c</code> &amp; d</p>',
    );
  });
});
