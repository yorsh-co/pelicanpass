import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ADMIN_USERNAME_MAX_LENGTH,
  isAdminUsername,
} from './admin-username.ts';

describe('isAdminUsername', () => {
  it('accepts plain handles', () => {
    for (const name of ['joshua', 'ana.clara', 'a_b-c', 'abc']) {
      assert.ok(isAdminUsername(name), name);
    }
  });

  it('accepts email addresses', () => {
    for (const name of [
      'joshua@example.com',
      'j.p+admin@sub.example.com.br',
      'ana@xn--caf-dma.com',
    ]) {
      assert.ok(isAdminUsername(name), name);
    }
  });

  it('accepts an email address at the length cap', () => {
    const domain = '@example.com';
    const name = `${'a'.repeat(ADMIN_USERNAME_MAX_LENGTH - domain.length)}${domain}`;

    assert.equal(name.length, ADMIN_USERNAME_MAX_LENGTH);
    assert.ok(isAdminUsername(name));
  });

  it('rejects values outside the length bounds', () => {
    assert.equal(isAdminUsername('ab'), false);
    assert.equal(
      isAdminUsername('a'.repeat(ADMIN_USERNAME_MAX_LENGTH + 1)),
      false,
    );
    assert.equal(
      isAdminUsername(`${'a'.repeat(ADMIN_USERNAME_MAX_LENGTH)}@example.com`),
      false,
    );
  });

  it('rejects malformed email addresses', () => {
    for (const name of [
      'joshua@',
      '@example.com',
      'a@b',
      'a@@b.com',
      'a b@c.com',
      'joshua@example..com',
      'joshua@example.com.',
    ]) {
      assert.equal(isAdminUsername(name), false, name);
    }
  });

  it('rejects input that was not normalised', () => {
    assert.equal(isAdminUsername('Joshua'), false);
    assert.equal(isAdminUsername('Joshua@Example.com'), false);
    assert.equal(isAdminUsername(' joshua'), false);
  });
});
