/**
 * The TMS file formats `i18n:export` writes and `i18n:import` reads.
 *
 * Each is one of the formatters built into `formatjs compile --format`, which
 * is what reads them back, so an exported file round-trips through the same
 * parser a translated one goes through. `smartling` is left out: its files
 * need a directive header this shape cannot carry.
 */

import type { SourceMessage } from './generate.ts';

/** Turns one source message into the entry a format stores under its ID. */
type Shape = (message: SourceMessage) => unknown;

export const TMS_FORMATS = {
  default: (message) => message,
  simple: (message) => message.defaultMessage,
  transifex: (message) => ({
    string: message.defaultMessage,
    developer_comment: message.description,
  }),
  lokalise: (message) => ({
    translation: message.defaultMessage,
    notes: message.description,
  }),
  crowdin: (message) => ({
    message: message.defaultMessage,
    description: message.description,
  }),
} as const satisfies Record<string, Shape>;

export type TmsFormat = keyof typeof TMS_FORMATS;

/**
 * Narrows a command-line value to a supported format.
 *
 * @param value - The `--format` argument.
 * @throws {Error} Naming the supported formats, if the value is not one.
 */
export const toTmsFormat = (value: string): TmsFormat => {
  if (Object.hasOwn(TMS_FORMATS, value)) return value as TmsFormat;

  throw new Error(
    `unknown format "${value}"; use one of: ${Object.keys(TMS_FORMATS).join(', ')}`,
  );
};
