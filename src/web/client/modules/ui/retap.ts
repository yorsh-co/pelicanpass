/**
 * How long a timed-out action is remembered for its re-tap.
 *
 * A re-tap answered by the refusal its own success would cause ("already
 * collected", "already answered") is read as that success inside this window.
 * Past it, the same refusal is more likely somebody else's action, and keeps
 * its usual copy.
 */
export const RETAP_WINDOW_MS = 60_000;

/** Remembers one action whose answer never arrived. */
export interface RetapMarker {
  /** Records that the action named by `key` timed out. */
  mark: (key: string) => void;

  /**
   * Reads and forgets the mark.
   *
   * @returns True when the mark was for `key` and is still within
   *   {@link RETAP_WINDOW_MS}.
   */
  take: (key: string) => boolean;
}

/**
 * Builds a marker for one screen's re-tappable action.
 *
 * For screens that cannot re-read what happened. A screen that can should
 * re-read instead: that shows the truth without anyone tapping again.
 *
 * @param now - Clock in milliseconds; `Date.now` outside tests.
 * @returns The marker.
 */
export const createRetapMarker = (
  now: () => number = Date.now,
): RetapMarker => {
  let marked: { key: string; at: number } | undefined;

  return {
    mark: (key) => {
      marked = { key, at: now() };
    },

    take: (key) => {
      const last = marked;

      marked = undefined;

      return last?.key === key && now() - last.at <= RETAP_WINDOW_MS;
    },
  };
};
