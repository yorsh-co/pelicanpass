import { qsOptional } from '../../../../layouts/main/dom.ts';

/** Per-field display formatters, keyed by the same key as the value. */
type ValueFormatters = Record<string, (value: string) => string>;

/**
 * Writes a step's data into the `[data-checkin="<step>-<key>"]` slots.
 *
 * Slots are looked up per key and skipped when absent, so a step's template
 * only has to carry the fields it actually shows.
 *
 * @param stepKey - Step whose slots to fill.
 * @param data - Values to display, keyed by field name.
 * @param options.formatters - Per-field transforms applied before display.
 *   The raw value is still written to `data-checkin-value`.
 */
export const populateStepValues = (
  stepKey: string,
  data: object = {},
  { formatters = {} }: { formatters?: ValueFormatters } = {},
): void => {
  // Callers pass typed views such as Partial<AttendeePreview>. Those are
  // interfaces, so they carry no index signature, and this reads them by key.
  const source = data as Record<string, string | undefined>;

  const values: Record<string, string | undefined> = { ...source };

  const elements: Record<string, HTMLElement | null> = {};

  for (const key in values) {
    elements[key] = qsOptional(`[data-checkin="${stepKey}-${key}"]`);
  }

  for (const key in values) {
    const formatter = formatters[key];
    if (formatter) {
      values[key] = formatter(values[key] ?? '');
    }
  }

  for (const key in values) {
    const el = elements[key];
    if (!el) continue;

    el.dataset.checkinValue = source[key] ?? '';
    el.textContent = values[key] ?? '';
  }
};

/**
 * Writes a step's static copy into its `[data-checkin="<step>-copy-<key>"]`
 * slots, skipping any the template does not carry.
 */
export const populateStepCopy = (
  stepKey: string,
  copy: Record<string, unknown> = {},
): void => {
  for (const key in copy) {
    const el = qsOptional(`[data-checkin="${stepKey}-copy-${key}"]`);
    if (!el) continue;

    const value = copy[key];
    if (typeof value === 'string') el.textContent = value;
  }
};
