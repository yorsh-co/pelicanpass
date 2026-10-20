import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { after, before, describe, it, mock } from 'node:test';

import { CASES, NOW, RELEASE } from './fixtures.ts';
import { createViewApp } from './render-app.ts';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Renders every top-level view through the real Express view engine and the
 * real `express-ejs-layouts` and compares the HTML with the files in
 * `__snapshots__`.
 *
 * The suite exists so that a template-engine upgrade, or a change to a shared
 * partial, shows up as a byte-level diff of the markup the browser (and so the
 * CSP) actually receives. Partials, components and layouts are covered through
 * the pages that include them.
 *
 * Determinism: the CSP nonce, the release id, the locale and the clock are
 * pinned, and the process time zone is forced to UTC while rendering.
 *
 * To accept an intended change, re-record every snapshot and review the diff:
 *
 *     UPDATE_VIEW_SNAPSHOTS=1 npm test -- --test-name-pattern 'view snapshots'
 *
 * (or run this file alone with `node --import ./src/test/setup-env.ts --test
 * src/web/views/render-snapshots.test.ts`). A missing snapshot fails, so a new
 * case is recorded the same way.
 */

const SNAPSHOTS = new URL('./__snapshots__/', import.meta.url);
const UPDATE = process.env.UPDATE_VIEW_SNAPSHOTS === '1';

const NONCE = 'dGVzdC1ub25jZS0wMDAwMDA=';

/** Where each case's HTML is kept. */
const snapshotUrl = (name: string): URL => new URL(`${name}.html`, SNAPSHOTS);

let server: Server;
let port: number;
let realTz: string | undefined;

before(async () => {
  realTz = process.env.TZ;
  process.env.TZ = 'UTC';
  mock.timers.enable({ apis: ['Date'], now: NOW });

  const app = createViewApp({
    cases: CASES,
    nonce: () => NONCE,
    releaseId: RELEASE,
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  port = (server.address() as AddressInfo).port;

  if (UPDATE) mkdirSync(SNAPSHOTS, { recursive: true });
});

after(async () => {
  mock.timers.reset();
  if (realTz === undefined) delete process.env.TZ;
  else process.env.TZ = realTz;

  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('view snapshots', () => {
  for (const { name } of CASES) {
    it(name, async () => {
      const response = await fetch(`http://127.0.0.1:${String(port)}/${name}`);
      const html = await response.text();

      assert.equal(response.status, 200, html);

      if (UPDATE) {
        writeFileSync(snapshotUrl(name), html);
        return;
      }

      assert.equal(
        html,
        readFileSync(snapshotUrl(name), 'utf8'),
        `${name} no longer matches its snapshot. If the change is intended, run with UPDATE_VIEW_SNAPSHOTS=1 and review the diff.`,
      );
    });
  }
});
