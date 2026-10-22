import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';

import { VENUE_MAP_SRC } from './venue-map.ts';

const PUBLIC_DIR = new URL('../web/public', import.meta.url);

describe('VENUE_MAP_SRC', () => {
  it('points every locale at a file that is served', () => {
    for (const [locale, src] of Object.entries(VENUE_MAP_SRC)) {
      assert.ok(
        existsSync(new URL(`.${src}`, `${PUBLIC_DIR.href}/`)),
        `${locale}: ${src} is not under src/web/public`,
      );
    }
  });

  it('gives English a map of its own', () => {
    assert.notEqual(VENUE_MAP_SRC.en, VENUE_MAP_SRC['pt-BR']);
  });
});
