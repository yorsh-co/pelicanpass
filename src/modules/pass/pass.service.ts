import crypto from 'crypto';

import { env } from '../../config/env.ts';
import redis from '../../shared/db/redis.ts';
import { hash } from '../../shared/utils/hash.ts';
import {
  BAND_COLOURS,
  BAND_WORDS,
  PASS_TOKEN_WINDOWS,
  PASS_WINDOW_MS,
} from '../../constants/pass.ts';

/**
 * Version marker at the head of every token payload.
 */
const TOKEN_VERSION = 'v1';

/**
 * How long a spent token's marker outlives the token itself.
 *
 * Derived rather than written as a literal: the marker only has to survive as
 * long as a token could still verify, and doubling that leaves room for a slow
 * scan without pinning a second number that could drift from the window.
 */
const USED_TOKEN_TTL_SECONDS = (PASS_WINDOW_MS * PASS_TOKEN_WINDOWS * 2) / 1000;

/** A derived band, as shown on the pass and on the volunteer's own screen. */
export interface PassBand {
  colour: string;
  word: string;
}

/**
 * Outcome of verifying a pass token.
 *
 * `expired` is separated from `invalid` because it is the one benign failure
 * with an action attached — the attendee refreshes their pass.
 */
export type PassTokenResult =
  | { ok: true; attendeeId: string }
  | { ok: false; reason: 'expired' | 'invalid' };

const INVALID: PassTokenResult = { ok: false, reason: 'invalid' };

/**
 * Signs a token payload.
 *
 * The signature covers the **encoded** payload rather than the fields it
 * decodes to, so verification checks the exact bytes that travelled.
 *
 * @param payload - The base64url payload segment.
 * @returns Base64url HMAC-SHA256 of that segment.
 */
const sign = (payload: string): string =>
  crypto
    .createHmac('sha256', env.passSecret)
    .update(payload)
    .digest('base64url');

/**
 * The window index the server is currently in.
 *
 * Callers must not derive this from a browser clock. The endpoint that serves
 * the pass returns the remaining time so the page can schedule its own refresh
 * against the server's view instead of the device's.
 *
 * @returns Whole windows elapsed since the epoch.
 */
export const currentWindow = (): number =>
  Math.floor(Date.now() / PASS_WINDOW_MS);

/**
 * Derives the band for a window.
 *
 * Identical for every attendee in that window, which is what lets a volunteer
 * check a pass without knowing whose it is. Keyed by the event so two
 * deployments sharing a secret would still not share a band. The word comes
 * from the list for `PASS_BAND_LANGUAGE`; the digest bytes, and so the band's
 * position in the list, do not depend on it.
 *
 * @param window - Window index, from {@link currentWindow}.
 * @returns The colour and word for that window.
 */
export const deriveBand = (window: number): PassBand => {
  const digest = crypto
    .createHmac('sha256', env.passSecret)
    .update(`band|${env.eventId}|${String(window)}`)
    .digest();

  const words = BAND_WORDS[env.passBandLanguage];

  // The masks cannot exceed either list's bounds, both being powers of two and
  // every language's list the same length, so the fallbacks are unreachable.
  // They are here because `noUncheckedIndexedAccess` has no way to see that.
  return {
    colour: BAND_COLOURS[digest.readUInt8(0) & 7] ?? BAND_COLOURS[0],
    word: words[digest.readUInt8(1) & 31] ?? words[0],
  };
};

/**
 * Mints a pass token for one attendee in the current window.
 *
 * @param attendeeId - Attendee the token identifies.
 * @returns The token, as `payload.signature`.
 */
export const issuePassToken = (attendeeId: string): string => {
  const payload = Buffer.from(
    `${TOKEN_VERSION}|${attendeeId}|${env.eventId}|${String(currentWindow())}`,
    'utf8',
  ).toString('base64url');

  return `${payload}.${sign(payload)}`;
};

/**
 * Derives the Redis key marking a token as spent.
 *
 * The signature is hashed rather than used directly, so a keyspace dump yields
 * digests instead of live credentials — the same reasoning as `session:` keys.
 *
 * @param signature - The token's signature segment.
 */
const usedKey = (signature: string): string => `pass:used:${hash(signature)}`;

/**
 * Un-spends a token that was consumed for a verify that then failed.
 *
 * Only one caller should ever want this: the staff surface consumes a token and
 * then opens a review, and if that fails for reasons of ours the attendee would
 * otherwise have burned a token for nothing and have to wait out the window
 * with a volunteer in front of them.
 *
 * **For infrastructure failures only.** The caller must not release after an
 * operational error — a profile that is not there, a participant carrying no
 * check-in number. Those answers are settled, so the retry a release buys
 * reaches the same one, and the token stays replayable in the meantime for
 * nothing. `StaffService.verify` draws that line on `AppError`.
 *
 * **Best effort.** If the failure was a failed mint, Redis is unreachable and
 * this fails too — and the whole staff surface is already answering 401 because
 * sessions live there. The case it does serve is Postgres down while Redis is
 * up, where the profile read throws and this succeeds. It costs one round trip
 * to turn a rare bad outcome into a rarer one.
 *
 * @param token - The token whose spend marker should be released.
 */
export const releasePassToken = async (token: string): Promise<void> => {
  const signature = token.split('.')[1];

  if (!signature) return;

  await redis.del(usedKey(signature));
};

/**
 * Verifies a scanned pass token and spends it.
 *
 * The order is deliberate. The signature is checked before any field it carries
 * is read, and the token is only **spent last**, once every other check has
 * passed — otherwise anyone able to reach the scanner could fill the keyspace
 * with markers for tokens they invented.
 *
 * A Redis failure is not caught. The staff surface is unreachable without Redis
 * anyway, since sessions live there, so failing open would buy no availability
 * and only drop the replay check — see "When Redis fails" in
 * `git show d0aa585:docs/anti-fraud-pass-plan.md`, in the private archive
 * repository.
 *
 * @param token - Raw payload scanned from the pass.
 * @returns The attendee it identifies, or why it was refused.
 */
export const verifyPassToken = async (
  token: string,
): Promise<PassTokenResult> => {
  const parts = token.split('.');
  const [payload, signature] = parts;

  if (parts.length !== 2 || !payload || !signature) return INVALID;

  const received = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(sign(payload), 'utf8');

  // timingSafeEqual throws on a length mismatch rather than returning false, so
  // without the length test a truncated signature is a 500 instead of a refusal.
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(received, expected)
  ) {
    return INVALID;
  }

  const fields = Buffer.from(payload, 'base64url').toString('utf8').split('|');
  const [version, attendeeId, eventId, window] = fields;

  if (fields.length !== 4 || version !== TOKEN_VERSION || !attendeeId) {
    return INVALID;
  }

  if (eventId !== env.eventId) return INVALID;

  const issued = Number(window);
  const now = currentWindow();

  // A token from a window that has not arrived yet cannot have been minted by
  // this server, so it is a forgery rather than a timing problem.
  if (!Number.isInteger(issued) || issued > now) return INVALID;

  if (issued <= now - PASS_TOKEN_WINDOWS)
    return { ok: false, reason: 'expired' };

  const marked = await redis.set(
    usedKey(signature),
    '1',
    'EX',
    USED_TOKEN_TTL_SECONDS,
    'NX',
  );

  if (marked === null) return INVALID;

  return { ok: true, attendeeId };
};
