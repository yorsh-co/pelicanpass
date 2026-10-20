/**
 * Finds a phase's knee: doubling `SCALE` until a rung fails, then bisecting
 * between the last pass and the first fail, then running each side of the
 * boundary a second time.
 *
 * Pure: it sees the rungs so far and names the next `SCALE`, so the runner
 * owns every side effect and the search is tested without a stack.
 */

/** A valid rung's outcome at one `SCALE`. */
export interface Outcome {
  scale: number;
  passed: boolean;
}

export interface KneeOptions {
  /** Largest `SCALE` to try; `loadtest/lib/config.ts` accepts up to 20. */
  maxScale: number;
  /** Stop bisecting once the last pass and the first fail are this close. */
  resolution: number;
  /** Runs each side of the boundary needs before the knee is settled. */
  repeats: number;
}

export const DEFAULT_KNEE_OPTIONS: KneeOptions = {
  maxScale: 20,
  resolution: 1,
  repeats: 2,
};

export type KneeStep =
  | { done: false; scale: number }
  | {
      done: true;
      /** The highest `SCALE` that passed every time; 0 if even 1 failed. */
      capacity: number;
      /** The lowest `SCALE` that failed, or `null` if none up to the maximum. */
      knee: number | null;
      /** A repeat disagreed, or a higher `SCALE` passed where a lower failed. */
      unstable: boolean;
    };

/**
 * The first boundary `SCALE` still short of its repeats, as a step to run.
 *
 * @param runs - Results per `SCALE`.
 * @param boundary - The scales either side of the knee.
 * @param repeats - Runs each one needs.
 */
const confirm = (
  runs: ReadonlyMap<number, readonly boolean[]>,
  boundary: readonly number[],
  repeats: number,
): KneeStep | null => {
  const short = boundary.find(
    (scale) => (runs.get(scale)?.length ?? 0) < repeats,
  );

  return short === undefined ? null : { done: false, scale: short };
};

/**
 * Where the boundary lies on the evidence so far, whether or not the search
 * that produced it has finished.
 *
 * A `SCALE` counts as passed only if every run of it passed, so a repeat that
 * fails pulls the boundary down and the capacity reported is the lower one.
 *
 * @param outcomes - Valid rungs of one phase and configuration, in any order.
 */
export const kneeBoundary = (outcomes: readonly Outcome[]) => {
  const runs = new Map<number, boolean[]>();

  for (const { scale, passed } of outcomes) {
    runs.set(scale, [...(runs.get(scale) ?? []), passed]);
  }

  const scales = [...runs.keys()].sort((a, b) => a - b);
  const passedAll = (scale: number) =>
    (runs.get(scale) ?? []).every((passed) => passed);
  const mixed = scales.some((scale) => {
    const results = runs.get(scale) ?? [];

    return results.includes(true) && results.includes(false);
  });

  const knee = scales.find((scale) => !passedAll(scale)) ?? null;
  const below = knee === null ? scales : scales.filter((scale) => scale < knee);
  const capacity = below.filter(passedAll).at(-1) ?? 0;
  const inverted =
    knee !== null && scales.some((scale) => scale > knee && passedAll(scale));

  return { runs, capacity, knee, unstable: mixed || inverted };
};

/**
 * Names the next `SCALE` to run, or the result once the knee is settled.
 *
 * @param outcomes - Valid rungs of this phase and configuration so far, in
 *   any order. Invalid rungs are the runner's to retry, not evidence.
 * @param options - {@link DEFAULT_KNEE_OPTIONS} unless overridden.
 */
export const nextKneeStep = (
  outcomes: readonly Outcome[],
  options: KneeOptions = DEFAULT_KNEE_OPTIONS,
): KneeStep => {
  const { maxScale, resolution, repeats } = options;
  const { runs, capacity, knee, unstable } = kneeBoundary(outcomes);

  if (knee === null) {
    if (capacity >= maxScale) {
      return (
        confirm(runs, [capacity], repeats) ?? {
          done: true,
          capacity,
          knee: null,
          unstable,
        }
      );
    }

    return {
      done: false,
      scale: Math.min(capacity === 0 ? 1 : capacity * 2, maxScale),
    };
  }

  if (knee - capacity > resolution) {
    const scale = Math.floor((capacity + knee) / 2);

    // At a resolution under 1 the midpoint of 1 and 2 floors back onto 1.
    if (scale > capacity) return { done: false, scale };
  }

  return (
    confirm(runs, capacity > 0 ? [capacity, knee] : [knee], repeats) ?? {
      done: true,
      capacity,
      knee,
      unstable,
    }
  );
};
