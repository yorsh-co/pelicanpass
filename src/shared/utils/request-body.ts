/**
 * Reads a string field off a parsed request body.
 *
 * Two hazards, both resolved by returning `undefined`. The body may not be an
 * object: Express 5 leaves `req.body` undefined when no parser matches the
 * `Content-Type`, and indexing that throws. The field may not be a string:
 * `req.body` is typed `any`, and `.test()` coerces, so a JSON number passes
 * `/^[0-9]{4}$/` and reaches `Buffer.from()`, which throws.
 *
 * **Absence and emptiness are reported separately** — `undefined` for a field
 * the body does not carry as a string, `''` for one it carries empty. Callers
 * that treat the two alike flatten with `?? ''`; callers for which an empty
 * value is a meaningful instruction, such as clearing a stored value, must not,
 * or a request whose body failed to parse becomes an instruction to erase.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @param field - Field to read.
 * @returns The field's value, or `undefined` if it is absent or not a string.
 */
export const readStringField = (
  body: unknown,
  field: string,
): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;

  const value = (body as Record<string, unknown>)[field];

  return typeof value === 'string' ? value : undefined;
};

/**
 * Reads a boolean field off a parsed request body.
 *
 * JSON `true` and `false` only. `'true'`, `1` and `'on'` are absent rather than
 * coerced: every caller posts JSON, and a lenient reading would let a
 * malformed body switch something on.
 *
 * @param body - Parsed request body, or whatever Express left in its place.
 * @param field - Field to read.
 * @returns The field's value, or `undefined` if it is absent or not a boolean.
 */
export const readBooleanField = (
  body: unknown,
  field: string,
): boolean | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;

  const value = (body as Record<string, unknown>)[field];

  return typeof value === 'boolean' ? value : undefined;
};
