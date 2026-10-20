import { COPY_DEFAULTS } from '../../constants/copy-defaults.ts';

/** A `{name}` placeholder: an identifier between braces, nothing else. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Fills the `{name}` placeholders in a Markdown source.
 *
 * Only a brace pair around an identifier counts. Square-bracket markers such
 * as `[RAZÃO SOCIAL]` are fields the operator fills in by hand and are left
 * as they are.
 *
 * @param source - The Markdown text.
 * @param values - The value for each placeholder name.
 * @param file - Label for the error message, usually the file's path.
 * @returns The text with every placeholder replaced.
 * @throws {Error} Naming the first placeholder that has no value.
 */
export const fillCopyPlaceholders = (
  source: string,
  values: Readonly<Record<string, string>> = COPY_DEFAULTS,
  file?: string,
): string =>
  source.replace(PLACEHOLDER, (_match, name: string) => {
    const value = Object.hasOwn(values, name) ? values[name] : undefined;

    if (value === undefined) {
      throw new Error(
        `${file === undefined ? '' : `${file}: `}unknown copy placeholder {${name}}`,
      );
    }

    return value;
  });
