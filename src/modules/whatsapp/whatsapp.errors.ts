/**
 * What the run engine does about one failed send.
 *
 * The split is most of the engine's value, and three of the four branches exist
 * because the obvious response to an error code is the wrong one.
 */
export type SendClassification =
  'permanent' | 'transient' | 'deferred' | 'fatal';

/**
 * Meta's error codes, and what each one means for the run.
 *
 * A map rather than a chain of `if`s so that it can be read against the table
 * in `git show e3cdaee:docs/whatsapp-sender-plan.md` §1 (in the private archive
 * repository) line by line. Four of these placements read wrong at a glance
 * and carry a comment saying why.
 *
 * Codes absent from this map are handled by {@link classifySend}, not by a
 * default written here: the fallthrough depends on the HTTP status, which a
 * lookup keyed on the code alone cannot see.
 */
export const WHATSAPP_ERROR_CLASS: Readonly<
  Record<number, SendClassification>
> = {
  // Permanent, this recipient only. The row is failed and the run moves on.
  131026: 'permanent', // Undeliverable: not on WhatsApp, ToS not accepted, or an outdated client.
  131051: 'permanent', // Unsupported message type.
  131008: 'permanent', // Required parameter missing.

  // Transient. The row stays pending and is retried on a later pass.
  130429: 'transient', // Cloud API throughput reached.
  80007: 'transient', // WABA rate limit.
  4: 'transient', // App-level call rate limit.
  131056: 'transient', // Pair rate limit: too many messages to this one recipient.
  131000: 'transient', // Unknown send failure.

  // A 24-hour hold, not a throttle. Retrying inside the run is how a quality
  // warning becomes a suspension, so the row is parked and the run finishes
  // honestly without pretending it succeeded.
  131049: 'deferred', // Withheld "to maintain healthy ecosystem engagement".

  // Fatal. Every one of these is true for all 700 recipients, not for one.
  190: 'fatal', // Access token expired.
  100: 'fatal', // Unsupported or misspelled parameter — a bug in our request shape.
  132000: 'fatal', // Variable count does not match the approved template.
  132001: 'fatal', // Template absent in that language, or unapproved.
  132005: 'fatal', // Translated text too long.
  132007: 'fatal', // Template violates policy.
  132012: 'fatal', // Variables formatted incorrectly.
  132015: 'fatal', // Template paused for low quality.
  368: 'fatal', // WABA restricted.
  131031: 'fatal', // Account restricted.
  133010: 'fatal', // Phone number not registered.
  33: 'fatal', // Business number deleted.

  // A quality verdict on the sending number, not a rate limit: messages from
  // it are being blocked or flagged as spam. Retrying is the single worst
  // available response, and the cost is not a delay — it is the end of the
  // number's usefulness.
  131048: 'fatal',
};

/**
 * Decides what to do about a send that did not succeed.
 *
 * The unmapped cases are the point of this function, and the rule is chosen
 * here rather than left to whoever meets the first unlisted code.
 *
 * **An unmapped code on a 4xx is permanent.** One unknown recipient-level
 * refusal must not stop the 699 sends behind it. A code that turns out to be
 * systemic is caught instead by the run engine's circuit breaker — ten
 * *consecutive* permanent failures — which exists precisely because a
 * classification is only ever as good as its coverage.
 *
 * **Everything else is transient**: any 5xx, and the `null` code that stands
 * for a network failure or a timeout, where no response arrived to carry one.
 *
 * @param code - Meta's `error.code`, or null when the request never got an
 *   answer.
 * @param httpStatus - The response status, or 0 when there was no response.
 * @returns What the run engine should do about it.
 */
export const classifySend = (
  code: number | null,
  httpStatus: number,
): SendClassification => {
  if (code !== null) {
    const known = WHATSAPP_ERROR_CLASS[code];

    if (known !== undefined) return known;
  }

  return httpStatus >= 400 && httpStatus < 500 ? 'permanent' : 'transient';
};

/**
 * Names a failed `fetch()` for the log and for the persisted `error_title`.
 *
 * Node and undici put the real reason (`ECONNRESET`, `ENOTFOUND`, "other side
 * closed") on `error.cause`, not on the error itself. Only `name` and `cause`
 * are read, never anything about the request, so the access token cannot reach
 * the log. Lives here, not in the client, so it is testable without `env.ts`.
 *
 * @param error - Whatever `fetch()` threw.
 * @returns The error name, and the cause as `code: message` when it has either.
 */
export const describeSendError = (
  error: unknown,
): { title: string; cause: string | null } => {
  if (!(error instanceof Error)) return { title: 'NetworkError', cause: null };

  const { cause } = error;

  if (typeof cause !== 'object' || cause === null) {
    return { title: error.name, cause: null };
  }

  const code =
    'code' in cause && typeof cause.code === 'string' ? cause.code : '';
  const message =
    'message' in cause && typeof cause.message === 'string'
      ? cause.message
      : '';

  return {
    title: error.name,
    cause: [code, message].filter(Boolean).join(': ') || null,
  };
};
