import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

import { required } from '../../config/read-env.ts';

/**
 * Hashing and verification for administrator passwords.
 *
 * Salted **and** peppered, which are two different controls for two different
 * threats:
 *
 * - The **salt** is 16 random bytes stored beside the hash. It defeats
 *   precomputation and stops two administrators who chose the same password
 *   from sharing a digest.
 * - The **pepper** is a deployment-wide secret held in the environment and
 *   never written to Postgres. It is what makes a database-only compromise
 *   useless: the application role holds `SELECT (password_hash)` on `admins`,
 *   so an injection or a leaked dump reaches every hash *and every salt*. An
 *   attacker then needs the container environment as well as the database —
 *   two services with separate credentials, which is the separation
 *   `01-roles.sh` and the column grants exist to maintain.
 *
 * No dependency is added for any of this. Node's scrypt is the KDF, and the
 * pepper is applied as an HMAC.
 */

/**
 * `crypto.scrypt`, promisified.
 *
 * The signature is restated rather than inferred: `promisify` resolves against
 * the first of scrypt's overloads, which takes no options object, so the
 * inferred type rejects the cost parameters below. Naming the shape here is
 * what keeps `derive` type-checked at its call sites.
 */
const scrypt = promisify(scryptCallback) as (
  password: Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * scrypt cost parameters.
 *
 * `N = 2**15` is 32 MiB per hash, which is the usual operating point and lands
 * around 100 ms on the hardware this runs on. It is deliberately not `2**17`
 * (134 MiB): the login endpoint is unauthenticated, so a handful of concurrent
 * attempts at that size is a memory-exhaustion vector against a container sized
 * for a Node process. The failure budget in rate.middleware.ts bounds how many
 * attempts are possible; this bounds what each one costs.
 *
 * `maxmem` has to be raised explicitly — Node's default is 32 MiB and scrypt
 * needs headroom above `128 * N * r` or it throws.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;

const MAX_MEM = 256 * 1024 * 1024;

/** Bytes of salt, and of derived key. */
const SALT_BYTES = 16;
const KEY_BYTES = 64;

/**
 * Which generation of pepper a stored hash was produced with.
 *
 * Carried in the hash string so the pepper can be rotated without a flag day:
 * accept both generations, re-hash each administrator on their next successful
 * login, then retire the old one. Bump this when `ADMIN_PASSWORD_PEPPER`
 * changes.
 */
const PEPPER_VERSION = 1;

/**
 * Applies the pepper, compressing the password to a fixed 32 bytes.
 *
 * An HMAC rather than concatenation: it is a keyed function of the whole
 * password, and its fixed-width output means nothing unusual — a very long
 * passphrase, an embedded null — reaches the KDF.
 *
 * Read straight from the environment rather than through `config/env.ts`: the
 * admin CLIs run in `migrate`, which holds this secret and none of the server's
 * other required ones. The server still validates the value at boot.
 *
 * @param plain - The password as typed.
 * @returns The peppered digest scrypt is run over.
 */
const pepper = (plain: string): Buffer =>
  createHmac('sha256', required('ADMIN_PASSWORD_PEPPER'))
    .update(plain, 'utf8')
    .digest();

/**
 * Derives the scrypt key for a password and salt.
 *
 * @param plain - The password as typed.
 * @param salt - Salt to derive against.
 * @param params - Cost parameters, read from the stored hash when verifying.
 */
const derive = async (
  plain: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> =>
  scrypt(pepper(plain), salt, KEY_BYTES, { ...params, maxmem: MAX_MEM });

/**
 * Hashes a password for storage.
 *
 * The returned string is self-describing — `scrypt$v<pepper>$N$r$p$salt$hash` —
 * so both the cost parameters and the pepper generation can change without
 * invalidating what is already stored.
 *
 * @param plain - The password as typed.
 * @returns The encoded hash, ready to write to `admins.password_hash`.
 */
export const hashPassword = async (plain: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plain, salt, PARAMS);

  return [
    'scrypt',
    `v${String(PEPPER_VERSION)}`,
    String(PARAMS.N),
    String(PARAMS.r),
    String(PARAMS.p),
    salt.toString('base64'),
    key.toString('base64'),
  ].join('$');
};

/** A stored hash, decomposed. */
interface ParsedHash {
  params: { N: number; r: number; p: number };
  salt: Buffer;
  key: Buffer;
}

/**
 * Decomposes a stored hash.
 *
 * @param stored - The value read from `admins.password_hash`.
 * @returns Its parts, or `null` if it is not a hash this module produced.
 */
const parse = (stored: string): ParsedHash | null => {
  const parts = stored.split('$');

  if (parts.length !== 7) return null;

  const [scheme, version, n, r, p, salt, key] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  if (scheme !== 'scrypt') return null;
  if (version !== `v${String(PEPPER_VERSION)}`) return null;

  const params = { N: Number(n), r: Number(r), p: Number(p) };

  if (!Object.values(params).every((value) => Number.isInteger(value))) {
    return null;
  }

  return {
    params,
    salt: Buffer.from(salt, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
};

/**
 * Verifies a password against a stored hash.
 *
 * @param plain - The password as typed.
 * @param stored - The value read from `admins.password_hash`.
 * @returns Whether they match. `false` for a malformed or foreign-format hash,
 *   which cannot be distinguished from a wrong password by the caller and
 *   should not be.
 */
export const verifyPassword = async (
  plain: string,
  stored: string,
): Promise<boolean> => {
  const parsed = parse(stored);

  if (!parsed) return false;

  const derived = await derive(plain, parsed.salt, parsed.params);

  if (derived.length !== parsed.key.length) return false;

  return timingSafeEqual(derived, parsed.key);
};

/**
 * A hash to verify against when no such administrator exists.
 *
 * Without it the login endpoint is a username oracle: a miss would return in
 * microseconds while a hit spends ~100 ms in scrypt, and the difference is
 * plainly visible over a network. The service verifies against this instead of
 * returning early, so both paths cost the same.
 *
 * Derived once at module load from a random password nobody holds. It is a
 * promise rather than a value because the derivation is async; awaiting the
 * same settled promise on every miss costs nothing after the first.
 */
export const DUMMY_HASH: Promise<string> = hashPassword(
  randomBytes(32).toString('base64'),
);
