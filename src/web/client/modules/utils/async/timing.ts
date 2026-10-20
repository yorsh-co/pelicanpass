import { sleep } from './sleep.ts';

/**
 * Holds until a minimum duration has elapsed since `startTime`, so a fast
 * operation still reads as deliberate rather than flashing past.
 *
 * @param startTime - `Date.now()` captured when the operation began.
 * @param min - Minimum total duration in milliseconds.
 */
export const ensureMinimum = async (
  startTime: number,
  min = 1200,
): Promise<void> => {
  const elapsed = Date.now() - startTime;
  if (elapsed < min) {
    await sleep(min - elapsed);
  }
};

/**
 * Holds until the next multiple of `interval` since `startTime`, keeping
 * successive steps on a common beat however long each one took.
 *
 * @param startTime - `Date.now()` captured when the sequence began.
 * @param interval - Beat length in milliseconds.
 * @returns The elapsed time, the boundary waited for, and how long it waited.
 */
export const waitForNextInterval = async (
  startTime: number,
  interval = 1000,
) => {
  const elapsed = Date.now() - startTime;

  const nextBoundary = Math.ceil(elapsed / interval) * interval;

  const waitTime = nextBoundary - elapsed;

  if (waitTime > 0) {
    await sleep(waitTime);
  }

  return {
    elapsed,
    nextBoundary,
    waited: waitTime,
  };
};

/**
 * Resolves after the next frame has been painted.
 *
 * The double `requestAnimationFrame` is deliberate: the first callback runs
 * before the frame is painted, so a caller that awaited it would still be
 * ahead of the layout it is waiting on.
 *
 * `resolve` is called from a block body rather than passed to
 * `requestAnimationFrame` directly, which would resolve the promise with the
 * frame timestamp. No caller reads it.
 */
export const waitForNextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });

const timing = { ensureMinimum, waitForNextInterval, waitForNextPaint };

export default timing;
