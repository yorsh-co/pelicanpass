/**
 * Shortest password accepted for a service credential or an administrator.
 *
 * Kept apart from `config/env.ts` so scripts/admin/create-admin.ts holds
 * administrators to the same bar without loading, and validating, the whole
 * server environment.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Defaults and placeholders no credential may be left set to. */
export const WEAK_PASSWORDS = new Set([
  'postgres',
  'redis',
  'password',
  'changeme',
  'change-me',
  'admin',
  '123456',
]);
