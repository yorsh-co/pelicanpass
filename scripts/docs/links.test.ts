import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Guards references to the documentation against moves and renames.
 *
 * Source files, configs and docs name `docs/…` files by their repo-root path,
 * and markdown documents link to each other by relative path. Neither is
 * checked by a compiler, so moving a document into a subfolder silently leaves
 * dangling references behind. `CHANGELOG.md` is exempt from the root-path check
 * because it records paths as they were at the time.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A repo-root doc path, not the tail of a longer path or a `git show <rev>:` ref. */
const DOC_PATH = /(?<![\w./:-])docs\/[\w./-]+\.(?:md|json)(?![\w-])/g;

/** An inline markdown link target, up to the closing parenthesis. */
const LINK = /\]\(([^)\s]+)[^)]*\)/g;

/** The `src` of an inline HTML image, which `LINK` does not see. */
const IMG = /<img\s[^>]*?src="([^"]+)"/g;

/** Targets that are not files: URLs, anchors and site-absolute routes. */
const NOT_A_FILE = /^(?:https?:|mailto:|#|\/)/;

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: ROOT,
  encoding: 'utf8',
})
  .split('\0')
  .filter((path) => path !== '' && existsSync(join(ROOT, path)));

/** Reads a tracked file, or `null` when it is binary. */
const readText = (path: string): string | null => {
  const buffer = readFileSync(join(ROOT, path));

  return buffer.includes(0) ? null : buffer.toString('utf8');
};

/** Blanks fenced code blocks so line numbers stay correct. */
const stripFences = (markdown: string): string => {
  let fenced = false;

  return markdown
    .split('\n')
    .map((line) => {
      const isFence = line.trimStart().startsWith('```');
      const keep = !fenced && !isFence;

      if (isFence) fenced = !fenced;

      return keep ? line : '';
    })
    .join('\n');
};

/**
 * Finds every match of a pattern with its line number.
 *
 * @param text - Text to search.
 * @param pattern - Global pattern; group 1, when present, is the result.
 */
const matches = (text: string, pattern: RegExp): [number, string][] =>
  [...text.matchAll(pattern)].map((match) => [
    text.slice(0, match.index).split('\n').length,
    match[1] ?? match[0],
  ]);

describe('doc references', () => {
  it('points every repo-root docs path at an existing file', () => {
    const failures = tracked
      .filter((path) => path !== 'CHANGELOG.md')
      .flatMap((path) =>
        matches(readText(path) ?? '', DOC_PATH)
          .filter(([, target]) => !existsSync(join(ROOT, target)))
          .map(([line, target]) => `${path}:${String(line)} → ${target}`),
      );

    assert.deepEqual(failures, []);
  });

  it('resolves every relative markdown link', () => {
    const failures = tracked
      .filter((path) => path.endsWith('.md'))
      .flatMap((path) =>
        matches(stripFences(readText(path) ?? ''), LINK)
          .filter(([, target]) => !NOT_A_FILE.test(target))
          .map(([line, target]): [number, string] => [
            line,
            decodeURIComponent(target.split('#')[0] ?? ''),
          ])
          .filter(([, target]) => target !== '')
          .filter(([, target]) => !existsSync(resolve(ROOT, dirname(path), target)))
          .map(([line, target]) => `${path}:${String(line)} → ${target}`),
      );

    assert.deepEqual(failures, []);
  });

  it('resolves every relative HTML image in markdown', () => {
    const failures = tracked
      .filter((path) => path.endsWith('.md'))
      .flatMap((path) =>
        matches(stripFences(readText(path) ?? ''), IMG)
          .filter(([, target]) => !NOT_A_FILE.test(target))
          .filter(([, target]) => !existsSync(resolve(ROOT, dirname(path), target)))
          .map(([line, target]) => `${path}:${String(line)} → ${target}`),
      );

    assert.deepEqual(failures, []);
  });
});
