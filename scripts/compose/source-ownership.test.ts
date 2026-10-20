import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Guards who owns the application code in the `prod` image.
 *
 * The process runs as `node`. If `node` also owns `/usr/src/app`, code
 * execution can rewrite the source and `node_modules` of the next start
 * wherever the filesystem is writable (a volume, a copy of the image run without
 * `read_only`). Everything under it is therefore root-owned and only the log
 * directory belongs to `node`. The image-level proof is `find /usr/src/app
 * -user node` in a built image, which needs Docker; this is the static half.
 */

const dockerfile = readFileSync(
  new URL('../../Dockerfile', import.meta.url),
  'utf8',
);

/** The `prod` stage, up to the next `FROM` or the end of the file. */
const prodStage = (): string => {
  const start = dockerfile.indexOf('AS prod');
  const next = dockerfile.indexOf('\nFROM ', start);

  return dockerfile.slice(start, next === -1 ? undefined : next);
};

/** Instruction lines of the stage, comments removed. */
const instructions = (): string[] =>
  prodStage()
    .split('\n')
    .filter((line) => /^[A-Z]+ /.test(line));

describe('prod image ownership', () => {
  it('copies nothing with --chown', () => {
    const chowned = instructions().filter(
      (line) => line.startsWith('COPY ') && line.includes('--chown'),
    );

    assert.deepEqual(chowned, []);
  });

  it('gives node only /var/log/pelicanpass', () => {
    const chowns = instructions().filter((line) => line.includes('chown'));

    assert.equal(chowns.length, 1);
    assert.match(chowns[0] ?? '', /chown node:node \/var\/log\/pelicanpass$/);
  });

  it('keeps RELEASE copied in and readable', () => {
    const release = instructions().find((line) => line.includes('/RELEASE'));

    assert.ok(release, 'the RELEASE stamp is copied into the image');
    assert.match(release, /--chmod=/);
  });

  it('still drops to node before the entrypoint', () => {
    assert.ok(instructions().includes('USER node'));
  });
});

describe('prod image contents', () => {
  /** The `COPY` instructions that take files from the build context. */
  const contextCopies = (): string[] =>
    instructions().filter(
      (line) => line.startsWith('COPY ') && !line.includes('--from'),
    );

  /** Directory copies; `package*.json` are single files with no tests. */
  const directoryCopies = (): string[] =>
    contextCopies().filter((line) => !line.includes('package*.json'));

  it('copies source and script directories', () => {
    assert.ok(directoryCopies().length >= 4);
  });

  it('ships no *.test.ts', () => {
    const missing = directoryCopies().filter(
      (line) => !line.includes('--exclude=**/*.test.ts'),
    );

    assert.deepEqual(missing, []);
  });

  it('ships no client sources, only the built bundles', () => {
    const src = contextCopies().find((line) => /\bsrc \.\/src$/.test(line));

    assert.ok(src, 'the src copy');
    assert.ok(src.includes('--exclude=web/client'), src);
  });
});

describe('fallback image contents', () => {
  /** The `fallback` stage, up to the next `FROM`. */
  const fallbackStage = (): string => {
    const start = dockerfile.indexOf('AS fallback');
    const next = dockerfile.indexOf('\nFROM ', start);

    return dockerfile.slice(start, next === -1 ? undefined : next);
  };

  const srcCopy = (): string | undefined =>
    fallbackStage()
      .split('\n')
      .find((line) => line.startsWith('COPY ') && /\bsrc \.\/src$/.test(line));

  it('ships no *.test.ts or snapshots', () => {
    const src = srcCopy();

    assert.ok(src, 'the src copy');
    assert.ok(src.includes('--exclude=**/*.test.ts'), src);
    assert.ok(src.includes('--exclude=**/__snapshots__'), src);
  });

  it('ships no client sources, only the built bundles', () => {
    const src = srcCopy();

    assert.ok(src, 'the src copy');
    assert.ok(src.includes('--exclude=web/client'), src);
  });
});
