/**
 * Fails when the message catalogs, the generated code or the templates that
 * read them disagree.
 *
 * - Every catalog compiles, every message has a description, and every
 *   translation takes the same arguments as its pt-BR source.
 * - src/i18n/generated is exactly what `i18n:build` would write.
 * - Neither the pseudo-locale nor a draft locale is offered in production.
 * - Every `copy.x()` in a template names an accessor of the namespaces the
 *   template declares with `<%# i18n: <namespace>, … %>` on its first line,
 *   and those namespaces share no accessor name. Every `chrome.x()` names a
 *   `chrome` accessor and every `shell.x()` an `admin-shell` one. Templates are not type-checked, and an unknown accessor
 *   fails only at render time.
 *
 * Usage:
 *   node scripts/i18n/check.ts
 */

import { globSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

import {
  DRAFT_LOCALES,
  PSEUDO_LOCALE,
  supportedLocales,
} from '../../src/i18n/locales.ts';
import { ROOT, generate, listGenerated } from './generate.ts';

import type { Namespace } from '../../src/i18n/namespaces.ts';

const VIEWS_DIR = `${ROOT}src/web/views`;
const HEADER_RE = /^<%#\s*i18n:([^%]*)%>/;
const ACCESSOR_RE = /\bcopy\.([A-Za-z0-9_]+)\(/g;

/** Response locals every template may call, and the namespace behind each. */
const GLOBALS: [RegExp, Namespace][] = [
  [/\bchrome\.([A-Za-z0-9_]+)\(/g, 'chrome'],
  [/\bshell\.([A-Za-z0-9_]+)\(/g, 'admin-shell'],
];

const { files, accessors, errors } = await generate();

for (const path of listGenerated()) {
  if (!files.has(path)) {
    errors.push(`${relative(ROOT, path)} is no longer generated`);
  }
}

for (const [path, content] of files) {
  let committed: string | undefined;

  try {
    committed = readFileSync(path, 'utf8');
  } catch {
    committed = undefined;
  }

  if (committed !== content) {
    errors.push(`${relative(ROOT, path)} is stale`);
  }
}

for (const locale of [PSEUDO_LOCALE, ...DRAFT_LOCALES]) {
  if (supportedLocales('production').includes(locale)) {
    errors.push(`${locale} is offered in production`);
  }
}

for (const file of globSync('**/*.ejs', { cwd: VIEWS_DIR }).sort()) {
  const template = readFileSync(`${VIEWS_DIR}/${file}`, 'utf8');
  for (const [pattern, ns] of GLOBALS) {
    const names = accessors.get(ns) ?? new Set<string>();

    for (const [, name = ''] of template.matchAll(pattern)) {
      if (!names.has(name)) {
        errors.push(`views/${file}: ${ns} has no message "${name}"`);
      }
    }
  }

  const used = [...template.matchAll(ACCESSOR_RE)].map((m) => m[1] ?? '');

  if (used.length === 0) continue;

  const declared = HEADER_RE.exec(template)?.[1]?.trim();

  if (!declared) {
    errors.push(`views/${file}: calls copy.* without an <%# i18n: … %> header`);
    continue;
  }

  const union = new Map<string, string>();

  for (const ns of declared.split(',').map((name) => name.trim())) {
    const names = accessors.get(ns as Namespace);

    if (!names) {
      errors.push(`views/${file}: no catalog for namespace "${ns}"`);
      continue;
    }

    for (const name of names) {
      const owner = union.get(name);

      if (owner) {
        errors.push(`views/${file}: "${name}" is in both ${owner} and ${ns}`);
      }

      union.set(name, ns);
    }
  }

  for (const name of new Set(used)) {
    if (!union.has(name)) {
      errors.push(`views/${file}: ${declared} has no message "${name}"`);
    }
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`i18n: ${error}`);
  console.error(
    'i18n: run `npm run i18n:build` after fixing the catalogs; see docs/development/copy-management.md',
  );
  process.exit(1);
}

console.log('✓ i18n check passed');
