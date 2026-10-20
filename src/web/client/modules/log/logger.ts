const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

/** Severity names, which double as the console methods they forward to. */
type LogLevel = keyof typeof LEVELS;

/** Signature shared by every method on {@link logger}. */
type LogFn = (scope: string, message: string, context?: unknown) => void;

/**
 * Threshold below which lines are dropped.
 *
 * Outside development that is `warn`: debug and info lines are diagnostic
 * chatter, and some carry attendee input — `modules/qr` logs the decoded
 * payload of every scan. Warnings and errors stay, since they are what makes a
 * failed check-in explicable from a phone in the field.
 *
 * Read from the same `data-nodeenv` attribute `debug/debug.ts` uses, set by
 * `views/layouts/main.ejs`. Safe at module scope: every bundle is a deferred
 * module script, so the body exists by the time this runs.
 */
const MIN_LEVEL: LogLevel =
  document.body.dataset.nodeenv === 'development' ? 'debug' : 'warn';

/**
 * Writes one line to the console, below the threshold check.
 *
 * @param level - Severity, and the console method used to emit it.
 * @param scope - Where the line came from, e.g. 'checkin.ticket'.
 * @param message - Human-readable summary.
 * @param context - Safe-to-log metadata only. Defaults to an empty string so
 *   an omitted context prints as nothing rather than as `undefined`.
 */
const log = (
  level: LogLevel,
  scope: string,
  message: string,
  context: unknown = '',
): void => {
  if (LEVELS[level] < LEVELS[MIN_LEVEL]) return;

  console[level](`[${scope}]`, message, context);
};

export const logger: Record<LogLevel, LogFn> = {
  debug: (scope, message, context) => {
    log('debug', scope, message, context);
  },
  info: (scope, message, context) => {
    log('info', scope, message, context);
  },
  warn: (scope, message, context) => {
    log('warn', scope, message, context);
  },
  error: (scope, message, context) => {
    log('error', scope, message, context);
  },
};
