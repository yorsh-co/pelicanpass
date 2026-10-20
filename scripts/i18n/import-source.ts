/**
 * Brings reviewed pt-BR copy back from a TMS export, then rebuilds the
 * generated catalogs.
 *
 * `i18n:import` is for translations, which the TMS owns and which it replaces
 * outright. The source is owned here: its IDs, descriptions and order stay as
 * they are, and only the wording of existing messages changes. Each ID is
 * routed to its namespace through the pt-BR catalogs, so the export's file
 * names and folder layout do not matter.
 *
 * The export is flat JSON (`{ "<id>": "<message>" }`), in any number of files
 * under `<dir>`. Before anything is written, each message must be for a known
 * ID, non-empty, valid ICU, and take exactly the arguments it took before: a
 * changed argument changes its accessor's signature, which needs its call
 * sites edited by hand. A message whose parsed form is unchanged — a TMS
 * re-escaping an apostrophe, say — is left as it is. If the build then refuses
 * the result, every file is put back.
 *
 * Usage:
 *   node scripts/i18n/import-source.ts <dir>
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parse } from '@formatjs/icu-messageformat-parser';

import { BASE_LOCALE } from '../../src/i18n/locales.ts';
import { NAMESPACES } from '../../src/i18n/namespaces.ts';
import { writeGenerated } from './build.ts';
import { MESSAGES_DIR, collectArguments, readCatalog } from './generate.ts';

import type { Namespace } from '../../src/i18n/namespaces.ts';
import type { SourceMessage } from './generate.ts';

type Catalog = Record<string, SourceMessage>;

/** What merging an export into the source catalogs would change. */
export interface MergeResult {
  /** Each namespace with at least one change: its new catalog and the changed IDs. */
  updated: Map<Namespace, { catalog: Catalog; changed: string[] }>;
  /** Source IDs the export does not have; they are left unchanged. */
  absent: string[];
  errors: string[];
}

/**
 * A message's arguments and their types, as its generated accessor takes them.
 *
 * @throws {Error} On a tag, or an argument used with two types.
 */
const signature = (message: string, id: string): string =>
  JSON.stringify(
    [...collectArguments(parse(message), id)].sort(([a], [b]) =>
      a.localeCompare(b),
    ),
  );

/**
 * Merges exported messages into the source catalogs, without touching disk.
 *
 * @param catalogs - The pt-BR catalogs, by namespace.
 * @param incoming - The exported messages, by ID.
 * @returns The catalogs that change, and every problem found. When `errors`
 *   is non-empty, nothing should be written.
 */
export const mergeSourceEdits = (
  catalogs: ReadonlyMap<Namespace, Catalog>,
  incoming: Readonly<Record<string, string>>,
): MergeResult => {
  const result: MergeResult = { updated: new Map(), absent: [], errors: [] };
  const namespaceOf = new Map<string, Namespace>();

  for (const [ns, catalog] of catalogs) {
    for (const id of Object.keys(catalog)) {
      namespaceOf.set(id, ns);
      if (!Object.hasOwn(incoming, id)) result.absent.push(id);
    }
  }

  for (const [id, message] of Object.entries(incoming)) {
    const ns = namespaceOf.get(id);
    const original = ns && catalogs.get(ns)?.[id];

    if (!ns || !original) {
      result.errors.push(`${id}: not in the ${BASE_LOCALE} catalogs`);
      continue;
    }

    if (!message.trim()) {
      result.errors.push(`${BASE_LOCALE}/${ns}: ${id}: empty`);
      continue;
    }

    try {
      if (
        JSON.stringify(parse(message)) ===
        JSON.stringify(parse(original.defaultMessage))
      ) {
        continue;
      }

      if (signature(message, id) !== signature(original.defaultMessage, id)) {
        result.errors.push(
          `${BASE_LOCALE}/${ns}: ${id}: arguments differ from the catalog's; change the message and its call sites by hand`,
        );
        continue;
      }
    } catch (err) {
      result.errors.push(
        `${BASE_LOCALE}/${ns}: ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    let entry = result.updated.get(ns);

    if (!entry) {
      entry = { catalog: { ...catalogs.get(ns) }, changed: [] };
      result.updated.set(ns, entry);
    }

    // Reassigning an existing key keeps its position in the file.
    entry.catalog[id] = { ...original, defaultMessage: message };
    entry.changed.push(id);
  }

  return result;
};

const sourcePath = (ns: Namespace): string =>
  `${MESSAGES_DIR}/${BASE_LOCALE}/${ns}.json`;

/**
 * Validates the command line.
 *
 * @throws {Error} On a missing or extra argument, or a missing directory.
 */
const readArguments = (): string => {
  const { positionals } = parseArgs({ allowPositionals: true });
  const [dir] = positionals;

  if (!dir || positionals.length > 1) {
    throw new Error('usage: import-source.ts <dir>');
  }

  if (!existsSync(dir)) throw new Error(`${dir} does not exist`);

  return resolve(dir);
};

/**
 * Reads every `.json` file under the export directory into one map of ID to
 * message.
 *
 * @throws {Error} On a file that is not flat JSON, or an ID two files give
 *   different messages.
 */
const readExport = (dir: string): Record<string, string> => {
  const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.json'))
    .sort();

  if (files.length === 0) throw new Error(`${dir} has no .json files`);

  const messages: Record<string, string> = {};

  for (const file of files) {
    let data: unknown;

    try {
      data = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8'));
    } catch (err) {
      throw new Error(`${file}: invalid JSON`, { cause: err });
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error(`${file}: not a JSON object`);
    }

    for (const [id, message] of Object.entries(data)) {
      if (typeof message !== 'string') {
        throw new Error(
          `${file}: ${id} is not a string; export flat JSON with an empty structure delimiter`,
        );
      }

      if (Object.hasOwn(messages, id) && messages[id] !== message) {
        throw new Error(`${file}: ${id} differs from an earlier file's`);
      }

      messages[id] = message;
    }
  }

  return messages;
};

/**
 * Writes the changed catalogs and rebuilds, putting every file back as it was
 * if the build refuses them.
 *
 * @param updated - The catalogs to write.
 * @returns Whether the build accepted them.
 */
const apply = async (updated: MergeResult['updated']): Promise<boolean> => {
  const previous = new Map<string, string>();

  for (const [ns, { catalog, changed }] of updated) {
    const path = sourcePath(ns);

    previous.set(path, readFileSync(path, 'utf8'));
    await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
    console.log(`i18n: ${BASE_LOCALE}/${ns}.json: ${changed.join(', ')}`);
  }

  if (await writeGenerated()) return true;

  for (const [path, content] of previous) await writeFile(path, content);

  console.error(`i18n: ${BASE_LOCALE} left unchanged`);

  return false;
};

if (import.meta.main) {
  try {
    const incoming = readExport(readArguments());
    const catalogs = new Map<Namespace, Catalog>();

    for (const { name } of NAMESPACES) {
      if (existsSync(sourcePath(name))) {
        catalogs.set(name, await readCatalog(sourcePath(name)));
      }
    }

    const { updated, absent, errors } = mergeSourceEdits(catalogs, incoming);

    if (errors.length > 0) {
      for (const error of errors) console.error(`i18n: ${error}`);
      console.error(`i18n: ${BASE_LOCALE} left unchanged`);
      process.exit(1);
    }

    for (const id of absent) {
      console.warn(`i18n: ${id} is not in the export, left unchanged`);
    }

    if (updated.size === 0) {
      console.log(`i18n: ${BASE_LOCALE} unchanged`);
    } else if (!(await apply(updated))) {
      process.exit(1);
    }
  } catch (err) {
    console.error(`i18n: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
