/**
 * The values filled into the copy placeholders: `{eventName}` and the like in
 * the Markdown content files and the message catalogs, and the footer's event
 * and organiser.
 *
 * This is the one place a later per-event setting overrides. Until then every
 * deployment renders these, so the shipped copy is complete without operator
 * input.
 */
export const COPY_DEFAULTS = {
  eventName: 'PelicanPass',
  organiserName: 'PelicanPass',
  organiserUrl: 'https://github.com/yorsh-co/pelicanpass',
} as const;

/** The placeholder names the copy may use. */
export type CopyDefaults = typeof COPY_DEFAULTS;
