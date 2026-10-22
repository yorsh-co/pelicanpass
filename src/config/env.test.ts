import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';

import type { SpawnSyncReturns } from 'node:child_process';

/** Every variable `env.ts` requires with its switches off, each valid. */
const BASELINE = {
  APP_URL: 'https://example.test',
  EVENT_ID: 'event',
  CHECKIN_QR_TOKEN: 'a1b2c3d4e5f6a7b8c9d0',
  PASS_SECRET: 'a'.repeat(64),
  ADMIN_PASSWORD_PEPPER: 'b'.repeat(64),
  POSTGRES_HOST: 'db',
  POSTGRES_DB: 'db',
  POSTGRES_USER: 'app',
  POSTGRES_PASSWORD: 'password1234',
  REDIS_HOST: 'cache',
  REDIS_PASSWORD: 'password1234',
  TURNSTILE_SITE_KEY: 'site',
  TURNSTILE_SECRET: 'secret',
  TURNSTILE_ADMIN_SITE_KEY: 'site',
  TURNSTILE_ADMIN_SECRET: 'secret',
};

/**
 * Imports `env.ts` in a child process, which is the only way to observe it:
 * it validates as it loads.
 *
 * Runs from a directory with no `.env`, so only `overrides` and the baseline
 * reach it.
 *
 * @param overrides - Variables to set on top of the baseline.
 */
const load = (overrides: Record<string, string>): SpawnSyncReturns<string> => {
  const entry = new URL('./env.ts', import.meta.url).href;

  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(entry)});`],
    {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, ...BASELINE, ...overrides },
      encoding: 'utf8',
    },
  );
};

describe('env CHECKIN_QR_TOKEN', () => {
  it('boots with a well-formed token', () => {
    const result = load({});

    assert.equal(result.status, 0, result.stderr);
  });

  const malformed: [label: string, token: string][] = [
    ['64 hex characters', 'f'.repeat(64)],
    ['fewer than 10 characters', 'a1b2c3d4e'],
    ['more than 32 characters', 'a'.repeat(33)],
    ['a non-alphanumeric character', 'a1b2c3d4e5-f6a7b8'],
  ];

  for (const [label, token] of malformed) {
    it(`refuses a token with ${label}`, () => {
      const result = load({ CHECKIN_QR_TOKEN: token });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /CHECKIN_QR_TOKEN must match/);
    });
  }
});

describe('env EVENT_CLOSES_AT', () => {
  const survey = {
    SURVEY_PARTICIPANT_ENABLED: 'true',
    SURVEY_OPENS_AT: '2026-09-13T20:00:00-03:00',
    SURVEY_CLOSES_AT: '2026-09-13T23:00:00-03:00',
  };

  const landing = {
    LANDING_ENABLED: 'true',
    EVENT_START_AT: '2026-09-13T19:00:00-03:00',
  };

  it('boots with a closing time after the event and the questionnaire', () => {
    const result = load({
      ...survey,
      ...landing,
      EVENT_CLOSES_AT: '2026-09-13T23:00:00-03:00',
    });

    assert.equal(result.status, 0, result.stderr);
  });

  it('refuses a closing time without a UTC offset', () => {
    const result = load({ EVENT_CLOSES_AT: '2026-09-14T08:00:00' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EVENT_CLOSES_AT must carry an explicit UTC/);
  });

  it('refuses a closing time before the questionnaire closes', () => {
    const result = load({
      ...survey,
      EVENT_CLOSES_AT: '2026-09-13T22:59:00-03:00',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not be before SURVEY_CLOSES_AT/);
  });

  it('refuses a closing time at or before the event starts', () => {
    const result = load({
      ...landing,
      EVENT_CLOSES_AT: '2026-09-13T19:00:00-03:00',
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be after EVENT_START_AT/);
  });
});

describe('env PASS_BAND_LANGUAGE', () => {
  it('boots with the default when unset', () => {
    const result = load({});

    assert.equal(result.status, 0, result.stderr);
  });

  it('boots with each supported language', () => {
    for (const language of ['pt-BR', 'en']) {
      const result = load({ PASS_BAND_LANGUAGE: language });

      assert.equal(result.status, 0, `${language}: ${result.stderr}`);
    }
  });

  it('refuses a language that has no word list', () => {
    for (const language of ['fr', 'pt', 'EN']) {
      const result = load({ PASS_BAND_LANGUAGE: language });

      assert.notEqual(result.status, 0, language);
      assert.match(
        result.stderr,
        /PASS_BAND_LANGUAGE must be one of/,
        language,
      );
    }
  });
});
