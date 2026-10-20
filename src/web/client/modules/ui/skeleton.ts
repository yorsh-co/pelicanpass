import { sleep } from '../utils/async/sleep.ts';
import { MIN_SKELETON_MS } from './pacing.ts';

let skeletonStartTime = 0;

export const start = (): void => {
  skeletonStartTime = Date.now();
};

/** Holds until the skeleton has been on screen long enough not to flicker. */
export const ensureMinTime = async (): Promise<void> => {
  const elapsed = Date.now() - skeletonStartTime;

  if (elapsed < MIN_SKELETON_MS) {
    await sleep(MIN_SKELETON_MS - elapsed);
  }
};

/** Replaces an element's content with its loading placeholder. */
export const render = (el: Element): void => {
  el.classList.add('skeleton');
};

/** Reveals an element's real content, one frame after next. */
export const clear = (el: Element): void => {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.classList.remove('skeleton');
    });
  });
};

const skeleton = {
  render,
  clear,
};

export default skeleton;

/**
 * Runs an operation, holding the result back until the skeleton has been
 * visible for {@link MIN_SKELETON_MS}.
 *
 * @param fn - Operation to run.
 * @returns Whatever `fn` resolved to.
 */
export const withSkeleton = async <T>(fn: () => T | Promise<T>): Promise<T> => {
  const startTime = Date.now();

  const result = await fn();

  const elapsed = Date.now() - startTime;

  if (elapsed < MIN_SKELETON_MS) {
    await sleep(MIN_SKELETON_MS - elapsed);
  }

  return result;
};
