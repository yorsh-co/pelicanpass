/**
 * The toast text for the `?error=` code the server redirected the pass with.
 *
 * The code comes from the query string, so it is looked up as an own property
 * only: `constructor` or `__proto__` must read as unknown rather than resolve
 * to a function or the prototype.
 *
 * @param copy - The pass init copy.
 * @param code - The raw `error` query value.
 */
export const passInitErrorMessage = (
  copy: { rateLimited: string; unknownError: string },
  code: string,
): string => {
  const flash: Record<string, string> = { RATE_LIMITED: copy.rateLimited };
  return Object.hasOwn(flash, code)
    ? (flash[code] ?? copy.unknownError)
    : copy.unknownError;
};
