import type { ErrorCopy } from '../../../../modules/qr/qr.types.ts';

/**
 * The toast text for the `?error=` code the server redirected here with.
 *
 * The code comes from the query string, so it is looked up as an own property
 * only: `constructor` or `__proto__` must read as unknown rather than resolve
 * to a function or the prototype.
 *
 * @param copy - The init copy for the visitor's audience.
 * @param code - The raw `error` query value.
 */
export const initErrorMessage = (
  copy: { error: ErrorCopy; unknownError: string },
  code: string,
): string =>
  Object.hasOwn(copy.error, code)
    ? (copy.error[code] ?? copy.unknownError)
    : copy.unknownError;
