import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

/**
 * Guards the supply chain of every image the project runs.
 *
 * A mutable tag lets a registry change, or an unreviewed upstream release, enter
 * production at the next pull with no diff to review. Every `image:` in every
 * compose file and every `FROM` in the Dockerfile must therefore name an index
 * digest, kept beside a readable tag: `name:tag@sha256:<64 hex>`. The bump
 * procedure is in docs/operations/deployment.md.
 */

const ROOT = new URL('../../', import.meta.url);

const PINNED = /^[^\s@]+:[^\s@]+@sha256:[0-9a-f]{64}$/;

const read = (path: string): string =>
  readFileSync(new URL(path, ROOT), 'utf8');

/** Every `image:` value in a compose file, keyed by service. */
const composeImages = (file: string): [string, string][] => {
  const doc = parse(read(file)) as {
    services: Record<string, { image?: string }>;
  };

  return Object.entries(doc.services).flatMap(([name, service]) =>
    service.image
      ? [[`${file} ${name}`, service.image] as [string, string]]
      : [],
  );
};

/** Every external `FROM` in the Dockerfile; stage references are not images. */
const dockerfileImages = (): [string, string][] => {
  const stages = new Set<string>();
  const images: [string, string][] = [];

  for (const line of read('Dockerfile').split('\n')) {
    const [keyword, image, , stage] = line.trim().split(/\s+/);

    if (keyword?.toUpperCase() !== 'FROM' || !image) continue;

    if (!stages.has(image))
      images.push([`Dockerfile ${stage ?? image}`, image]);

    if (stage) stages.add(stage);
  }

  return images;
};

/**
 * Tooling that runs an image outside Compose: the standby scripts and the two
 * tests that start a cached container. Each is found by the line that names the
 * image, and must yield at least one.
 */
const TOOLING: [file: string, startsWith: string][] = [
  ['scripts/standby/lib.sh', 'readonly STANDBY_'],
  ['scripts/db/export-results.test.ts', "'postgres:"],
  ['scripts/caddyfile.test.ts', "'caddy:"],
];

/** Image references quoted on the lines of a file that start with a marker. */
const toolingImages = (file: string, startsWith: string): string[] =>
  read(file)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(startsWith) && line.includes("'"))
    .map((line) => line.split("'")[1] ?? '');

const composeFiles = readdirSync(ROOT).filter(
  (name) => name.startsWith('compose') && name.endsWith('.yml'),
);

describe('image pins', () => {
  for (const [file, startsWith] of TOOLING) {
    it(`${file} names an image`, () => {
      assert.ok(toolingImages(file, startsWith).length > 0);
    });

    for (const image of toolingImages(file, startsWith)) {
      it(`${file} pins ${image || 'an image'} by index digest`, () => {
        assert.match(
          image,
          PINNED,
          `${image} must be name:tag@sha256:<digest>`,
        );
      });
    }
  }

  it('finds the compose files and the Dockerfile stages it guards', () => {
    assert.ok(composeFiles.includes('compose.prod.yml'));
    assert.ok(dockerfileImages().length >= 5);
  });

  for (const [where, image] of [
    ...composeFiles.flatMap(composeImages),
    ...dockerfileImages(),
  ]) {
    it(`${where} is pinned by index digest`, () => {
      assert.match(image, PINNED, `${image} must be name:tag@sha256:<digest>`);
    });
  }
});
