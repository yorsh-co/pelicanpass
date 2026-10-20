/**
 * The canonical form of a UUID, which is the only shape `attendee_id` and
 * `admin_id` ever take.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reports whether a value is a well-formed UUID.
 *
 * Worth checking before a value reaches a query rather than after: Postgres
 * answers a malformed one with `22P02 invalid input syntax for type uuid`,
 * which reaches `errorHandler` as a 500 and reports a bad request as a broken
 * server.
 *
 * Shared because two callers need the same predicate and want different
 * answers to it — the API refuses with a `ValidationError`, the rendered page
 * redirects back to the roster — and two copies of a regex are two things that
 * can drift.
 *
 * @param value - Candidate, typically a route parameter. Express 5 types those
 *   as `string | string[]`, so this narrows as well as validates.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);
