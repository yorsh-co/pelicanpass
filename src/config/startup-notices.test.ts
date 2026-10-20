import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { logStartupNotices } from './startup-notices.ts';

/** Runs the notices for one configuration and returns the warn-level lines. */
const warnings = (nodeEnv: string, enforce: boolean): string[] => {
  const lines: string[] = [];

  logStartupNotices(
    { warn: (message: string) => lines.push(message) },
    { nodeEnv, captchaAdmin: { enforce } },
  );

  return lines;
};

describe('logStartupNotices', () => {
  it('warns once in production when admin captcha enforcement is off', () => {
    const lines = warnings('production', false);

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /TURNSTILE_ADMIN_ENFORCE is false/);
    assert.match(lines[0] ?? '', /lock/);
    assert.match(lines[0] ?? '', /Turnstile outage/);
  });

  it('is silent in production when enforcement is on', () => {
    assert.deepEqual(warnings('production', true), []);
  });

  it('is silent in development when enforcement is off', () => {
    assert.deepEqual(warnings('development', false), []);
  });
});
