/**
 * The software's authorship credit, shown in every page footer as "by {name}"
 * with the name linking to {@link CREDIT.url}. The footer and the admin rail
 * also carry a GitHub icon linking to {@link CREDIT.sourceUrl}.
 *
 * Fixed attribution, not a per-event value: unlike `COPY_DEFAULTS`, no event
 * setting overrides it.
 */
export const CREDIT = {
  name: 'Yorsh',
  /** The author's site. */
  url: 'https://yorsh.co/',
  /** The project's public source repository. */
  sourceUrl: 'https://github.com/yorsh-co/pelicanpass',
} as const;

/** The shape of the authorship credit. */
export type Credit = typeof CREDIT;
