/**
 * Writes the pt-BR source of every translatable namespace in a TMS file
 * format, one file per namespace, for upload to the translation system.
 *
 * Non-translatable namespaces are never exported. IDs are the TMS keys and
 * descriptions travel as translator context.
 *
 * `xliff` is export-only: XLIFF 1.2, with each description in `<note>`, for a
 * TMS whose JSON import drops descriptions (Tolgee). Bring the translations
 * back in one of the JSON formats, which `i18n:import` reads.
 *
 * Usage:
 *   node scripts/i18n/export.ts [--format <name>] [--out <dir>]
 *
 *   --format  default | simple | transifex | lokalise | crowdin | xliff
 *             (default: default)
 *   --out     output directory (default: .ignore/i18n-export)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { BASE_LOCALE } from '../../src/i18n/locales.ts';
import { NAMESPACES } from '../../src/i18n/namespaces.ts';
import { MESSAGES_DIR, ROOT, readCatalog } from './generate.ts';
import { TMS_FORMATS, toTmsFormat } from './tms-formats.ts';

import type { SourceMessage } from './generate.ts';
import type { TmsFormat } from './tms-formats.ts';

/** Escapes text for an XML element or a double-quoted attribute. */
const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * One namespace as an XLIFF 1.2 document: the pt-BR text as `<source>` and the
 * description as `<note>`. No `<target>`: nothing is translated yet.
 *
 * @param ns - The namespace, kept as the file's `original`.
 * @param messages - Its messages, in ID order.
 */
const toXliff = (
  ns: string,
  messages: readonly [string, SourceMessage][],
): string =>
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">',
    `  <file source-language="${BASE_LOCALE}" datatype="plaintext" original="${escapeXml(ns)}">`,
    '    <body>',
    ...messages.flatMap(([id, message]) => [
      `      <trans-unit id="${escapeXml(id)}">`,
      `        <source>${escapeXml(message.defaultMessage)}</source>`,
      `        <note>${escapeXml(message.description)}</note>`,
      '      </trans-unit>',
    ]),
    '    </body>',
    '  </file>',
    '</xliff>',
    '',
  ].join('\n');

const { values } = parseArgs({
  options: {
    format: { type: 'string', default: 'default' },
    out: { type: 'string', default: `${ROOT}.ignore/i18n-export` },
  },
});

const format = ((): TmsFormat | 'xliff' => {
  if (values.format === 'xliff') return 'xliff';

  try {
    return toTmsFormat(values.format);
  } catch (err) {
    console.error(
      `i18n: ${err instanceof Error ? err.message : String(err)}, or xliff`,
    );
    process.exit(1);
  }
})();

const outDir = resolve(values.out);

await mkdir(outDir, { recursive: true });

let count = 0;

for (const { name: ns, translatable } of NAMESPACES) {
  if (!translatable) continue;

  const source = await readCatalog(`${MESSAGES_DIR}/${BASE_LOCALE}/${ns}.json`);
  const messages = Object.entries(source).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  if (format === 'xliff') {
    await writeFile(`${outDir}/${ns}.xliff`, toXliff(ns, messages));
  } else {
    const shape = TMS_FORMATS[format];

    await writeFile(
      `${outDir}/${ns}.json`,
      `${JSON.stringify(
        Object.fromEntries(
          messages.map(([id, message]) => [id, shape(message)]),
        ),
        null,
        2,
      )}\n`,
    );
  }

  count += 1;
}

const shown = relative(ROOT, outDir);

console.log(
  `i18n: exported ${String(count)} namespaces as ${format} to ${shown.startsWith('..') ? outDir : shown}`,
);
