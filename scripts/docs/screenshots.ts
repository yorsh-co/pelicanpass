/**
 * Captures the README screenshots from the static demo.
 *
 * Serves `dist/demo` on an ephemeral localhost port, drives the real pages in
 * Chromium and writes one compressed PNG per screen to
 * `docs/images/screenshots/`. The demo's attendees are fictional, so nothing
 * here is personal data.
 *
 * Stable output: the clock, time zone, locale and `Math.random` are fixed, and
 * motion is reduced, and the rotation window's ring is held at one level. The
 * demo banner is hidden; it is not part of the product.
 * Every step waits for the state it expects rather than for a duration,
 * because the demo's mock API answers after a random latency.
 *
 * Needs the demo build (`npm run build:demo`) and a Chromium that Playwright
 * can find in its cache (`~/.cache/ms-playwright`); it downloads nothing.
 *
 * Usage:
 *   node scripts/docs/screenshots.ts                 writes
 *                                                    docs/images/screenshots
 *   node scripts/docs/screenshots.ts --out <dir>     writes <dir>
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';
import sharp from 'sharp';

import {
  DEMO_TICKET_CODES,
  DEMO_VERIFICATION_CODE,
} from '../../src/web/client/demo/roster.ts';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Browser, BrowserContext, Page } from 'playwright-core';

const DEMO_DIR = fileURLToPath(new URL('../../dist/demo', import.meta.url));

const DEFAULT_OUT_DIR = fileURLToPath(
  new URL('../../docs/images/screenshots', import.meta.url),
);

/** A phone, as the pass is meant to be read. */
const MOBILE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
} as const;

const DESKTOP = {
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
} as const;

/** Fixed so the pass clock and the metrics page read the same on every run. */
const CLOCK = new Date('2026-11-14T10:30:00-03:00');

const TIME_ZONE = 'America/Sao_Paulo';

/** Upper bound for any single wait; the mock's latency is well under a second. */
const WAIT_MS = 30_000;

/** Fictional attendees from `src/web/client/demo/roster.ts`. */
const [PARTICIPANT_CODE] = DEMO_TICKET_CODES.participant;
const [VOLUNTEER_CODE] = DEMO_TICKET_CODES.volunteer;

/** A participant who is already checked in and holds every entitlement. */
const CHECKED_IN_CODE = 'b6g1j4';

/**
 * Injects a stylesheet hiding the demo banner, which is demo-only chrome and
 * not part of the screens shown. Runs in the page, on every document.
 */
const HIDE_BANNER = `document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = '.demo-banner { display: none !important; }';
  document.head.append(style);
});`;

/**
 * Injects a stylesheet holding the rotation window's ring at three quarters.
 * The page drains it from `performance.now()`, which the fixed clock does not
 * freeze, so its gap would otherwise depend on how long each capture took.
 * `!important` outranks the inline value the page writes every second.
 */
const PIN_WINDOW_RING = `document.addEventListener('DOMContentLoaded', () => {
  const style = document.createElement('style');
  style.textContent = '.window-ring { --window-remaining: 0.75 !important; }';
  document.head.append(style);
});`;

/** Content types of the files the demo ships. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

/**
 * Seeds `Math.random` (mulberry32) so the mock's raffle draws the same number
 * on every run. Runs in the page, before any script.
 */
const SEED_RANDOM = `(() => {
  let state = 0x9e3779b9;
  Math.random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

/** Parses the `_redirects` rules the demo uses: `from to status`. */
const parseRedirects = async (): Promise<Map<string, [string, number]>> => {
  const text = await readFile(path.join(DEMO_DIR, '_redirects'), 'utf8');
  const rules = new Map<string, [string, number]>();

  for (const line of text.split('\n')) {
    const [from, to, status] = line.trim().split(/\s+/);
    if (from?.startsWith('/') && to !== undefined && status !== undefined) {
      rules.set(from, [to, Number(status)]);
    }
  }

  return rules;
};

/**
 * Serves the demo directory the way Cloudflare Pages does: the file itself,
 * else the page with `.html` added, with the `_redirects` rules applied first.
 *
 * @returns The listening server, bound to an ephemeral loopback port.
 */
const serveDemo = async (): Promise<Server> => {
  const redirects = await parseRedirects();

  const resolveFile = (pathname: string): string | null => {
    const file = path.join(DEMO_DIR, pathname);
    if (!file.startsWith(DEMO_DIR + path.sep)) return null;

    return [file, `${file}.html`].find((candidate) => existsSync(candidate)) ??
      null;
  };

  const server = createServer((request, response) => {
    void (async () => {
      let { pathname } = new URL(request.url ?? '/', 'http://localhost');
      const rule = redirects.get(pathname);

      if (rule?.[1] === 302) {
        response.writeHead(302, { Location: rule[0] }).end();
        return;
      }
      if (rule !== undefined) pathname = rule[0];

      const file = resolveFile(decodeURIComponent(pathname));
      if (file === null || path.extname(file) === '') {
        response.writeHead(404).end();
        return;
      }

      response.writeHead(200, {
        'Content-Type':
          CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      response.end(await readFile(file));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return server;
};

/** Opens a context with the fixed environment every screenshot shares. */
const newContext = async (
  browser: Browser,
  baseURL: string,
  device: typeof MOBILE | typeof DESKTOP,
): Promise<BrowserContext> => {
  const context = await browser.newContext({
    ...device,
    baseURL,
    locale: 'pt-BR',
    timezoneId: TIME_ZONE,
    reducedMotion: 'reduce',
  });

  await context.addInitScript(SEED_RANDOM);
  await context.addInitScript({ content: HIDE_BANNER });
  await context.addInitScript({ content: PIN_WINDOW_RING });

  return context;
};

/** Opens a page with the clock held at {@link CLOCK}. */
const newPage = async (context: BrowserContext): Promise<Page> => {
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT_MS);
  await page.clock.setFixedTime(CLOCK);

  return page;
};

/** Waits for web fonts, so icons and lettering are drawn before the capture. */
const settle = (page: Page): Promise<unknown> =>
  page.evaluate('document.fonts.ready');

/**
 * Waits for a check-in step's hint to be shown. `ui/hint.ts` sets it after a
 * short delay and fades it in, so the step being ready says nothing about it.
 */
const waitForHint = (page: Page, step: 'ticket' | 'verification') =>
  page
    .locator(
      `[data-checkin="${step}-hint-div"]:not(.changing):text-matches("[A-Za-z]")`,
    )
    .waitFor();

/** Types a code into an input and submits it. */
const submitCode = async (page: Page, selector: string, code: string) => {
  const input = page.locator(`${selector}:enabled`);
  await input.waitFor();
  await input.fill(code);
  await input.press('Enter');
};

/** Writes a screenshot as an optimised palette PNG. */
const writePng = async (
  outDir: string,
  name: string,
  png: Buffer,
): Promise<void> => {
  const file = path.join(outDir, `${name}.png`);
  const optimised = await sharp(png)
    .png({ palette: true, compressionLevel: 9, effort: 10 })
    .toBuffer();

  await writeFile(file, optimised);
  console.log(`${file} (${String(optimised.byteLength)} bytes)`);
};

/**
 * Captures every README screenshot.
 *
 * @param outDir - Directory to write into; created as needed.
 */
export const captureScreenshots = async (outDir: string): Promise<void> => {
  if (!existsSync(path.join(DEMO_DIR, 'checkin.html'))) {
    throw new Error(
      `${DEMO_DIR} has no demo build. Run \`npm run build:demo\` first.`,
    );
  }

  await mkdir(outDir, { recursive: true });

  const server = await serveDemo();
  const baseURL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  const browser = await chromium.launch();

  const shoot = async (page: Page, name: string) => {
    await settle(page);
    await writePng(outDir, name, await page.screenshot());
  };

  try {
    // A participant, through the whole check-in flow.
    const participantContext = await newContext(browser, baseURL, MOBILE);
    const participant = await newPage(participantContext);

    await participant.goto('/checkin');
    await participant
      .locator('[data-checkin="ticket-step"]:not(.skeleton)')
      .waitFor();
    await waitForHint(participant, 'ticket');
    await shoot(participant, 'checkin-ticket');

    await submitCode(
      participant,
      '[data-checkin="ticket-code-input"]',
      PARTICIPANT_CODE,
    );
    await participant
      .locator('[data-checkin="verification-step"]:not(.skeleton)')
      .waitFor();
    await participant
      .locator('[data-checkin="verification-name"]:not(:has-text("•"))')
      .waitFor();
    await waitForHint(participant, 'verification');
    await shoot(participant, 'checkin-verification');

    await submitCode(
      participant,
      '[data-checkin="verification-code-input"]',
      DEMO_VERIFICATION_CODE,
    );
    await participant.locator('[data-checkin="qr-presence-btn"]').click();

    await participant.waitForURL('**/pass');
    await participant.locator('[data-pass="pass"]:not(.skeleton)').waitFor();
    await participant
      .locator('[data-pass="checkinNumber"]:text-matches("#[0-9]+")')
      .waitFor();
    await shoot(participant, 'pass-front');

    await participant.locator('[data-pass="showQr"]').click();
    await participant.locator('[data-pass="faceBack"]').waitFor();
    await participant
      .locator('[data-pass="passBand"]:text-matches("[A-Za-z0-9]")')
      .waitFor();
    await shoot(participant, 'pass-back');
    await participantContext.close();

    // A volunteer, in a fresh context so the sessions do not mix.
    const volunteerContext = await newContext(browser, baseURL, MOBILE);
    const volunteer = await newPage(volunteerContext);

    await volunteer.goto('/checkin');
    await submitCode(
      volunteer,
      '[data-checkin="ticket-code-input"]',
      VOLUNTEER_CODE,
    );
    await submitCode(
      volunteer,
      '[data-checkin="verification-code-input"]',
      DEMO_VERIFICATION_CODE,
    );
    await volunteer.locator('[data-checkin="qr-presence-btn"]').click();

    await volunteer.waitForURL('**/pass');
    await volunteer.locator('[data-pass="accessTab"]:not([hidden])').waitFor();
    await volunteer.locator('[data-pass="pass"]:not(.skeleton)').waitFor();
    await shoot(volunteer, 'pass-volunteer');

    await volunteer.goto('/staff');
    await volunteer.locator('[data-staff="lookup"] summary').click();
    await submitCode(
      volunteer,
      '[data-staff="lookupInput"]',
      CHECKED_IN_CODE,
    );
    await volunteer
      .locator('[data-staff="review"]:not([hidden]) [data-staff="slideHint"]:not([hidden])')
      .waitFor();
    await shoot(volunteer, 'staff');

    await volunteer.goto('/raffle');
    await volunteer.locator('[data-raffle="drawButton"]:enabled').click();
    await volunteer
      .locator('[data-raffle="announce"]:text-matches("[A-Za-z0-9]")')
      .waitFor({ state: 'attached' });
    await shoot(volunteer, 'raffle');
    await volunteerContext.close();

    // The admin pages are read-only fixtures, so a fresh desktop context will do.
    const adminContext = await newContext(browser, baseURL, DESKTOP);
    const admin = await newPage(adminContext);

    await admin.goto('/admin/redemptions');
    await shoot(admin, 'admin-redemptions');

    await admin.goto('/admin/metrics');
    await shoot(admin, 'admin-metrics');
    await adminContext.close();
  } finally {
    await browser.close();
    server.close();
  }
};

if (import.meta.main) {
  const flag = process.argv.indexOf('--out');
  const outArg = flag === -1 ? undefined : process.argv[flag + 1];

  if (flag !== -1 && (outArg === undefined || outArg.startsWith('--'))) {
    throw new Error('--out needs a directory');
  }

  await captureScreenshots(path.resolve(outArg ?? DEFAULT_OUT_DIR));
}
