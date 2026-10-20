/**
 * Characters that make a spreadsheet read a cell as a formula, or that start
 * one in some of them.
 */
export const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Reports whether a CSV cell would open as a formula.
 *
 * Tests the cell as written and again with surrounding whitespace trimmed, so
 * a leading tab or CR is caught before a reader's `trim()` drops it, and a
 * space in front of `=` does not hide it.
 *
 * @param raw - The cell exactly as parsed, untrimmed.
 */
export const startsLikeFormula = (raw: string): boolean =>
  FORMULA_START.test(raw) || FORMULA_START.test(raw.trim());
