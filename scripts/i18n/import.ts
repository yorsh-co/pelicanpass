/**
 * Brings a locale's translations in from TMS files, then rebuilds the
 * generated catalogs.
 *
 * Each `<dir>/<namespace>.json` replaces `src/i18n/messages/<locale>/<namespace>.json`
 * outright: the TMS owns translations, and those files are never hand-edited.
 * They are stored in the source's own shape, with the pt-BR description, so a
 * reviewer reading one sees what each message is for. Empty strings — how most
 * TMS exports carry an untranslated key — are dropped, and the build serves
 * pt-BR in their place for a draft locale.
 *
 * `formatjs compile --format` reads each file and rejects invalid ICU. The
 * build that follows rejects an unknown ID or a translation whose arguments
 * differ from the source's; if it does, the previous files are put back.
 * Nothing is written unless every file parses.
 *
 * Usage:
 *   node scripts/i18n/import.ts --locale <tag> --format <name> <dir>
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  BASE_LOCALE,
  PSEUDO_LOCALE,
  isLocale,
} from '../../src/i18n/locales.ts';
import { NAMESPACES } from '../../src/i18n/namespaces.ts';
import { writeGenerated } from './build.ts';
import { FORMATJS_BIN, MESSAGES_DIR, readCatalog } from './generate.ts';
import { toTmsFormat } from './tms-formats.ts';

import type { Locale } from '../../src/i18n/locales.ts';
import type { SourceMessage } from './generate.ts';
import type { TmsFormat } from './tms-formats.ts';

/** One namespace's translation, ready to write. */
interface Translation {
  path: string;
  catalog: Record<string, SourceMessage>;
}

/**
 * Validates the command line.
 *
 * @throws {Error} On a missing, unknown or untranslatable locale, an unknown
 *   format, or a missing directory.
 */
const readArguments = (): {
  locale: Locale;
  format: TmsFormat;
  dir: string;
} => {
  const { values, positionals } = parseArgs({
    options: {
      locale: { type: 'string' },
      format: { type: 'string' },
    },
    allowPositionals: true,
  });

  const [dir] = positionals;

  if (!values.locale || !values.format || !dir || positionals.length > 1) {
    throw new Error('usage: import.ts --locale <tag> --format <name> <dir>');
  }

  const { locale } = values;

  if (!isLocale(locale)) {
    throw new Error(`${locale} is not in LOCALES (src/i18n/locales.ts)`);
  }

  if (locale === BASE_LOCALE || locale === PSEUDO_LOCALE) {
    throw new Error(`${locale} is not translated`);
  }

  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);

  return { locale, format: toTmsFormat(values.format), dir: resolve(dir) };
};

/**
 * Reads one TMS file into the shape the build reads.
 *
 * @param file - The TMS file.
 * @param ns - Its namespace.
 * @param locale - The target locale.
 * @param format - The file's format.
 * @throws {Error} On invalid ICU or an ID the source does not have.
 */
const readTranslation = async (
  file: string,
  ns: string,
  locale: Locale,
  format: TmsFormat,
): Promise<Translation> => {
  const source = await readCatalog(`${MESSAGES_DIR}/${BASE_LOCALE}/${ns}.json`);
  let output: string;

  try {
    output = execFileSync(FORMATJS_BIN, ['compile', '--format', format, file], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    // `formatjs` reports the problem on the first line of its stderr and
    // follows it with its own stack.
    const stderr =
      err instanceof Error && 'stderr' in err && typeof err.stderr === 'string'
        ? err.stderr
        : '';
    const [reason = ''] = stderr.split('\n');

    throw new Error(`${ns}: ${reason.trim() ? reason : 'formatjs failed'}`, {
      cause: err,
    });
  }

  const strings = JSON.parse(output) as Record<string, string>;
  const catalog: Record<string, SourceMessage> = {};

  for (const id of Object.keys(strings).sort()) {
    const original = source[id];
    const message = strings[id];

    if (!original) {
      throw new Error(`${ns}: ${id} is not in the ${BASE_LOCALE} catalog`);
    }

    if (!message?.trim()) continue;

    catalog[id] = {
      defaultMessage: message,
      description: original.description,
    };
  }

  return { path: `${MESSAGES_DIR}/${locale}/${ns}.json`, catalog };
};

/**
 * Writes the translations and rebuilds, putting every file back as it was if
 * the build refuses them.
 *
 * @param locale - The target locale.
 * @param translations - What to write.
 * @returns Whether the build accepted them.
 */
const apply = async (
  locale: Locale,
  translations: Translation[],
): Promise<boolean> => {
  const previous = new Map(
    translations.map(({ path }) => [
      path,
      existsSync(path) ? readFileSync(path, 'utf8') : undefined,
    ]),
  );

  await mkdir(`${MESSAGES_DIR}/${locale}`, { recursive: true });

  for (const { path, catalog } of translations) {
    await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(
      `i18n: ${basename(path)} (${locale}): ${String(Object.keys(catalog).length)} messages`,
    );
  }

  if (await writeGenerated()) return true;

  for (const [path, content] of previous) {
    if (content === undefined) await rm(path);
    else await writeFile(path, content);
  }

  console.error(`i18n: ${locale} left unchanged`);

  return false;
};

try {
  const { locale, format, dir } = readArguments();
  const translatable = new Map<string, boolean>(
    NAMESPACES.map(({ name, translatable }) => [name, translatable]),
  );

  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (files.length === 0) throw new Error(`${dir} has no .json files`);

  const translations: Translation[] = [];

  // Every file is read and checked before any is written.
  for (const file of files) {
    const ns = basename(file, '.json');
    const isTranslatable = translatable.get(ns);

    if (isTranslatable === undefined) {
      throw new Error(`${file}: no namespace "${ns}"`);
    }

    if (!isTranslatable) throw new Error(`${file}: ${ns} is not translatable`);

    translations.push(
      await readTranslation(`${dir}/${file}`, ns, locale, format),
    );
  }

  if (!(await apply(locale, translations))) process.exit(1);
} catch (err) {
  console.error(`i18n: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
