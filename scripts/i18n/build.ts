/**
 * Writes src/i18n/generated from the message catalogs, removing anything
 * there that is no longer generated.
 *
 * Missing translations of a draft locale are reported and served in pt-BR;
 * every other problem fails the build before anything is written.
 *
 * Usage:
 *   node scripts/i18n/build.ts
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import { ROOT, generate, listGenerated } from './generate.ts';

/**
 * Generates and writes the catalogs' output.
 *
 * @returns Whether the output was written. On `false` the problems have been
 *   printed and nothing on disk changed.
 */
export const writeGenerated = async (): Promise<boolean> => {
  const { files, errors, warnings } = await generate();

  for (const warning of warnings) console.warn(`i18n: ${warning}`);

  if (errors.length > 0) {
    for (const error of errors) console.error(`i18n: ${error}`);
    return false;
  }

  for (const path of listGenerated()) {
    if (!files.has(path)) {
      await rm(path);
      console.log(`removed ${relative(ROOT, path)}`);
    }
  }

  for (const [path, content] of files) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  console.log(`i18n: wrote ${String(files.size)} files`);

  return true;
};

if (import.meta.main && !(await writeGenerated())) process.exit(1);
