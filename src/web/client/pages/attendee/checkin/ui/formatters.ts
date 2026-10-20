/** Strips a verification code down to its four digits. */
export const formatVerificationCode = (value: string): string =>
  value.replace(/[^0-9]/g, '').slice(0, 4);

export const isValidVerificationCode = (value: string): boolean =>
  /^[0-9]{4}$/.test(value);
