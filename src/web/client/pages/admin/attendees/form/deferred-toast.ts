import type { ToastLevel } from '../../../../modules/ui/toast.ts';

/** How long a toast stays up by default, as in `Toast`. */
export const DEFAULT_DURATION_MS = 5000;

/** How long a toast carrying the ticket limit warning stays up. */
const COMBINED_DURATION_MS = 8000;

/** Severity order, so the combined toast never understates the primary one. */
const SEVERITY: Record<ToastLevel, number> = {
  debug: 0,
  info: 1,
  success: 1,
  warn: 2,
  error: 3,
};

/** A toast's level and text. */
interface ToastContent {
  level: ToastLevel;
  message: string;
}

/** A toast ready to show. */
interface CombinedToast extends ToastContent {
  /** Milliseconds on screen. */
  duration: number;
}

/**
 * Merges the confirmation a page defers with the ticket limit warning into one
 * toast, since a toast replaces the one before it.
 *
 * With a warning, the toast takes the more severe of the confirmation's level
 * and `warn`, appends the warning to the text and stays up longer to be read.
 *
 * @param primary - The confirmation or door message outcome, if any.
 * @param exceeded - The ticket limit warning, if one is due.
 * @returns The toast to show, or `null` when there is nothing to say.
 */
export const combineToast = (
  primary: ToastContent | null,
  exceeded: string | null,
): CombinedToast | null => {
  if (exceeded === null) {
    return primary && { ...primary, duration: DEFAULT_DURATION_MS };
  }

  if (primary === null) {
    return {
      level: 'warn',
      message: exceeded,
      duration: DEFAULT_DURATION_MS,
    };
  }

  const level =
    SEVERITY[primary.level] > SEVERITY.warn ? primary.level : 'warn';

  return {
    level,
    message: `${primary.message} ${exceeded}`,
    duration: COMBINED_DURATION_MS,
  };
};
