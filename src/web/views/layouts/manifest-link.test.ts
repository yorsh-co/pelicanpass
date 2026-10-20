import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/** The layouts that link the web app manifest. */
const LAYOUTS = ['main.ejs', 'plain.ejs'];

describe('manifest link', () => {
  for (const layout of LAYOUTS) {
    // A manifest is fetched without cookies unless asked otherwise, and the
    // edge's site-wide Managed Challenge refuses a request with no
    // cf_clearance, so a bare link resolves to a 403.
    it(`${layout} fetches the manifest with credentials`, () => {
      const source = readFileSync(new URL(layout, import.meta.url), 'utf8');
      const links = source.match(/<link rel="manifest"[^>]*>/g);

      assert.ok(links, `${layout} has no manifest link`);
      for (const link of links) {
        assert.match(link, /\scrossorigin="use-credentials"/);
      }
    });
  }
});
