import { ALERT_FORBIDDEN_FIELDS } from '../logger/redact-paths.ts';

/** What a telemetry call site may attach to an occurrence. */
export type TelemetryFields = Readonly<
  Record<string, string | number | boolean>
>;

/**
 * Censors any field whose name is on the forbidden list.
 *
 * The last line of defence before a value leaves the process — for Discord, and
 * for the `context` column of `app_events`. Call sites are expected not to pass
 * personal data in the first place; this is what makes that a control rather
 * than a convention.
 *
 * Censored rather than silently removed, so a mistake is visible in the channel
 * or the row instead of invisible. A field that vanishes looks like a field
 * nobody sent.
 *
 * Shared by `alerts.ts` and `events.ts` on purpose. Two scrubbers that can
 * disagree is worse than one, because it reads as covered.
 *
 * @param fields - Values a call site attached to an occurrence.
 * @returns The same shape, with forbidden names replaced by `[REDACTED]`.
 */
export const scrub = (fields: TelemetryFields): TelemetryFields =>
  Object.fromEntries(
    Object.entries(fields).map(([name, value]) =>
      ALERT_FORBIDDEN_FIELDS.has(name.toLowerCase())
        ? [name, '[REDACTED]']
        : [name, value],
    ),
  );
