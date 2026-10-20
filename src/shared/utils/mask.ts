/**
 * Masks a full name down to a first name and a last initial, so a check-in
 * preview can confirm identity without echoing the whole record back.
 *
 * Names of more than two parts collapse the middle to an ellipsis:
 * `Maria Silva Santos` becomes `Maria ... S.`
 *
 * @param name - Full name as stored on the attendee record.
 * @returns The masked name, or an empty string if there is no name.
 */
export const maskName = (name: string): string => {
  if (!name) return '';

  const parts = name.split(' ');

  // split always yields at least one element, but noUncheckedIndexedAccess
  // cannot see that, so both ends are read defensively.
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';

  return `${first}${parts.length > 2 ? ' ...' : ''} ${last.charAt(0)}.`;
  //return parts.map((p, i) => (i === 0 ? p : p[0] + '...')).join(' ');
};

/**
 * Reduces a full name to the first name alone.
 *
 * The pass greets the attendee by name on a screen built to be screenshotted
 * and shared, so the surname has no business reaching the browser. The stored
 * column keeps the full name, which the admin screens display and search.
 *
 * @param name - Full name as stored on the attendee record.
 * @returns The first name, or an empty string if there is no name.
 */
export const firstName = (name: string): string => {
  if (!name) return '';

  return name.trim().split(' ')[0] ?? '';
};

/**
 * Masks a phone number by dropping its last six digits, leaving enough
 * leading digits for an attendee to recognise their own number.
 *
 * @param phone - Phone number as stored on the attendee record.
 * @returns The masked number, or an empty string if there is no number.
 */
export const maskPhone = (phone: string): string => {
  if (!phone) return '';

  return phone.slice(0, -6);
};

/**
 * Reads the verification code out of a stored phone number.
 *
 * The inverse of {@link maskPhone}, which drops exactly these digits: the last
 * four are what an attendee supplies to prove a ticket is theirs, and
 * `docs/security/data-retention.md` calls them "the only thing standing between a guessed
 * six-character ticket code and someone else's check-in".
 *
 * **This returns a shared secret.** It belongs on the administrator lookup's
 * single-attendee page and nowhere else — never in a log line, never in a list,
 * never in a response an attendee can reach. Everywhere else that needs to show
 * a number wants {@link maskPhone}.
 *
 * There is no guard for an empty number on purpose. `verifyAttendee` compares
 * against `attendee_phone.slice(-4)` directly, so this has to agree with it in
 * the degenerate cases too, and `''.slice(-4)` is already `''`.
 *
 * @param phone - Phone number as stored on the attendee record.
 * @returns The last four digits.
 */
export const verificationCodeOf = (phone: string): string => phone.slice(-4);

/**
 * Query parameters whose value must never reach a log line.
 *
 * `t` is `ticket_link_token`, a live per-attendee credential delivered over
 * WhatsApp. The rest are here because a URL is not supposed to carry them at
 * all: a form that reaches the network as a `GET` puts every field in the query
 * string, and the sign-in form did exactly that when its script failed to load,
 * writing plaintext passwords into the request log.
 *
 * `q` is different from the rest, and is here for its content rather than its
 * shape. It is free text matched against `attendee_name`, `attendee_nickname`,
 * `ticket_code` and phone digits, so a single search can hold any of the three
 * values `docs/security/data-retention.md` states the request logs do not.
 *
 * **Nothing in this application puts it in a URL any more.** The administrator
 * searches submit it in a body, precisely because a URL is written to the
 * browser's history — so this entry is now a backstop for a hand-typed address,
 * a bookmark predating that change, or a future screen that reaches for the
 * query string without reading `parseAttendeeFilters` first. It is redacted in
 * both places: `req.body.q` in `shared/logger/logger.ts`, beside the
 * `/staff/lookup` query that reached the same conclusion from the other side.
 *
 * `preview` is `LANDING_BYPASS_TOKEN`, which `landing.middleware.ts` exchanges
 * for a bypass cookie. It opens check-in before the window does, so a request
 * that carries it, valid or not, must not log it.
 *
 * `phone` is the WhatsApp sender's test-send field. It travels in a body, and
 * this is the backstop for a request that puts it in a URL instead.
 *
 * Longest first. The alternation is tried in order, so listing `t` ahead of
 * `token` would rely on backtracking to match the longer name.
 */
const SECRET_PARAMS = [
  'hub.verify_token',
  'password',
  'preview',
  'token',
  'phone',
  'code',
  'q',
  't',
] as const;

/**
 * The receipt callback's path secret, which is not a query parameter at all.
 *
 * **{@link maskUrlSecrets} only ever looked at the query string**, so without
 * this the last segment of `/api/v1/whatsapp/webhook/<secret>` would be written
 * to the request log in full, on every delivery. The secret is noise reduction
 * rather than a control — the HMAC is the boundary — but a value chosen to be
 * unguessable has no business being printed thousands of times.
 *
 * Cloudflare logs it too, where we cannot reach it. That residue is recorded in
 * plan §7 rather than pretended away here.
 */
const WEBHOOK_PATH_PATTERN = /(\/whatsapp\/webhook\/)[^/?#]+/gi;

/** `?password=…` or `&t=…`, up to the next parameter. */
const SECRET_PARAM_PATTERN = new RegExp(
  `([?&](?:${SECRET_PARAMS.join('|')})=)[^&]*`,
  'gi',
);

/**
 * Redacts credential-bearing query values from a URL before it reaches the logs.
 *
 * **Every path that logs a URL passes it through here**, and that is the rule
 * rather than a list: the `req` serializer, the rate limiter, the API error
 * handler, the web error handler and the cross-origin rejection all log one.
 * This comment used to say "twice" and name the two that existed at the time,
 * which four later call sites quietly falsified — a count goes stale the next
 * time a handler is added, and nothing fails when it does.
 *
 * This is a backstop, not the control. A credential belongs in a request body,
 * and the surfaces that handle one are built that way; masking here is what
 * keeps a bug in that arrangement from becoming a logged secret. It cannot help
 * with what the browser already wrote to its own history.
 *
 * The poster token (`?k=`) is deliberately left alone — it is printed on a wall
 * and public from the moment the doors open, and seeing it in the logs is useful
 * when reconciling how attendees arrived.
 *
 * @param url - Request URL, absolute or relative.
 * @returns The URL with every {@link SECRET_PARAMS} value replaced by a
 *   redaction marker.
 */
export const maskUrlSecrets = (url: string): string =>
  url
    .replace(SECRET_PARAM_PATTERN, '$1[REDACTED]')
    .replace(WEBHOOK_PATH_PATTERN, '$1[REDACTED]');
