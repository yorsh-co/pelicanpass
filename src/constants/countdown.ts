/**
 * The countdown's units, in one place.
 *
 * The landing page renders them twice — the server writes the first value into
 * the markup so the page is correct before any script runs, and the browser
 * rewrites it every second after that. Two implementations would disagree at
 * exactly the moment the page is being watched most closely.
 *
 * Imported by browser code, so it must stay free of Node built-ins.
 */

/** @param value - Hours, minutes or seconds to pad to two digits. */
const pad = (value: number): string => String(value).padStart(2, '0');

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** One countdown reading, split into the units the page draws. */
export interface CountdownParts {
  /**
   * Whole days left, `0` inside the last twenty-four hours. The page hides its
   * day pill on that rather than showing a zero, so the display tightens as the
   * event nears.
   */
  days: number;

  /** Zero-padded to two characters, which is what the digit reels expect. */
  hours: string;
  minutes: string;
  seconds: string;

  /**
   * The whole remainder, clamped. Carried alongside the units because the page
   * switches layout under a minute and reading that off `hours`/`minutes`
   * means parsing back what was just formatted.
   */
  totalMs: number;
}

/**
 * Splits a remaining duration into days, hours, minutes and seconds.
 *
 * Clamps at zero rather than counting past it: a negative countdown is a clock
 * disagreement, and showing it would be showing the disagreement.
 *
 * @param remainingMs - Milliseconds until the moment being counted to.
 */
export const splitCountdown = (remainingMs: number): CountdownParts => {
  const totalMs = Math.max(0, remainingMs);
  const total = Math.floor(totalMs / 1000);

  return {
    days: Math.floor(total / DAY),
    hours: pad(Math.floor((total % DAY) / HOUR)),
    minutes: pad(Math.floor((total % HOUR) / MINUTE)),
    seconds: pad(total % MINUTE),
    totalMs,
  };
};
