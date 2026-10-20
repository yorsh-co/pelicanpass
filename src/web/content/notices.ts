import { existsSync, readFileSync } from 'node:fs';

import { COPY_DEFAULTS } from '../../constants/copy-defaults.ts';
import { BASE_LOCALE, LOCALES } from '../../i18n/locales.ts';
import { fillCopyPlaceholders } from '../../shared/utils/copy-placeholders.ts';
import { renderMarkdown } from '../../shared/utils/markdown.ts';

import type { Locale } from '../../i18n/locales.ts';

/**
 * Renders one of the long-form pages under src/web/content/<locale> to HTML.
 *
 * These are authored as Markdown so their text can be updated without touching
 * markup. Parsed once at boot: the files ship inside the image and cannot
 * change under a running process. Reading them here means a missing or
 * unreadable base-locale file fails the boot rather than serving an empty
 * notice.
 *
 * The pt-BR text is the authoritative one. A locale without its own file — no
 * translation yet, or none signed off — is served the pt-BR document.
 *
 * Rendered with `renderMarkdown`, which escapes raw HTML and drops links and
 * images whose address is not relative, `http`, `https` or `mailto`, so the
 * output is safe to emit unescaped even if a notice is edited carelessly.
 *
 * @param locale Locale to read the document for.
 * @param file Filename under src/web/content/<locale>.
 * @returns The rendered HTML, ready for the notice view.
 */
const readNotice = (locale: Locale, file: string): string => {
  const localised = new URL(`./${locale}/${file}`, import.meta.url);
  const source = existsSync(localised)
    ? localised
    : new URL(`./${BASE_LOCALE}/${file}`, import.meta.url);

  return renderMarkdown(
    fillCopyPlaceholders(
      readFileSync(source, 'utf8'),
      COPY_DEFAULTS,
      `src/web/content/${locale}/${file}`,
    ),
  );
};

/** The privacy notice and terms of use, rendered, for every locale. */
export const NOTICES = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    {
      privacy: readNotice(locale, 'privacy-notice.md'),
      terms: readNotice(locale, 'terms-of-use.md'),
    },
  ]),
) as Record<Locale, { privacy: string; terms: string }>;
