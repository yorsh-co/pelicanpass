/**
 * Resolves after a fixed delay.
 *
 * @param ms - Delay in milliseconds.
 */
export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
