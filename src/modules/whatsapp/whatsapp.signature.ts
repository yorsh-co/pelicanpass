import crypto from 'node:crypto';

import { env } from '../../config/env.ts';

/**
 * Verification of Meta's `X-Hub-Signature-256`, and nothing else.
 *
 * **This is the whole boundary of the receipt callback.** The path suffix is
 * noise reduction, the Cloudflare ASN rule is an edge filter, and the rate
 * limiters bound volume — none of them authenticate anything. This does.
 */

/** The prefix Meta puts in front of the hex digest. */
const PREFIX = 'sha256=';

/**
 * Whether a body carries Meta's signature for it.
 *
 * Keyed on the **app secret** (Meta App → Settings → Basic), never the access
 * token: the two are the same phrase in conversation and different credentials
 * from different screens, and `config/env.ts` belabours the distinction for the
 * same reason.
 *
 * Computed over the **raw bytes**. A parsed body cannot be re-serialised
 * byte-identically — key order and whitespace are lost — which is why the
 * webhook router carries its own parser with a `verify` hook rather than using
 * the global one.
 *
 * The length test before `timingSafeEqual` is the idiom from
 * `pass.service.ts`, verbatim and for the same reason: that function **throws**
 * on a length mismatch rather than returning false, so a truncated signature
 * without the guard is a 500 where a refusal belongs.
 *
 * Both comparands are hex of a fixed width, so the lengths match for every
 * well-formed signature and the guard only ever fires on a malformed one.
 *
 * @param rawBody - The exact bytes Meta posted, before parsing.
 * @param header - The `X-Hub-Signature-256` value as Express hands it over.
 *   Typed to include the array form, which is what a repeated header arrives
 *   as: it is not a signature, and it is refused rather than joined.
 * @returns Whether the signature is Meta's for these bytes.
 */
export const verifyWebhookSignature = (
  rawBody: Buffer | undefined,
  header: string | string[] | undefined,
): boolean => {
  // No secret means nothing can be verified, so nothing is accepted. The boot
  // assertion in `env.ts` makes this unreachable while the webhook is enabled;
  // it is here because "unverifiable" must never read as "valid".
  if (!env.whatsapp.appSecret) return false;

  if (!rawBody || typeof header !== 'string' || !header.startsWith(PREFIX)) {
    return false;
  }

  const received = Buffer.from(header.slice(PREFIX.length), 'utf8');

  const expected = Buffer.from(
    crypto
      .createHmac('sha256', env.whatsapp.appSecret)
      .update(rawBody)
      .digest('hex'),
    'utf8',
  );

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
};
