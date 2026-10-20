import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

/**
 * Guards the CLIs the production docs run on `app`.
 *
 * The `prod` image copies only `src`, so a script the operator is told to run
 * with `docker compose exec app node scripts/…` has to be copied there
 * explicitly, along with everything it imports. `app` also holds no migrator or
 * read-only credential, so such a script must not reach `scripts/admin/db.ts`
 * or name those variables. Scripts that need them run on `migrate` instead.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Documents that tell the operator what to run in production. */
const PRODUCTION_DOCS = ['docs/operations/deployment.md'];

/** Scripts the docs are known to run on `app`; guards the matcher below. */
const KNOWN = [
  'scripts/qr/urls.ts',
  'scripts/telemetry/smoke.ts',
  'scripts/telemetry/traffic-summary.ts',
  'scripts/whatsapp/send-test.ts',
];

/** Documented on `app` for the development stack only; production never runs it. */
const DEV_ONLY = ['scripts/db/seed.ts'];

const APP_SCRIPT = /\bapp node (scripts\/\S+\.ts)/;

const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** Lists every non-test `.ts` file under `scripts/`. */
const scriptFiles = (dir = 'scripts'): string[] =>
  readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`;

    if (statSync(join(ROOT, path)).isDirectory()) return scriptFiles(path);

    return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [path] : [];
  });

/**
 * Collects the scripts a text tells the operator to run on `app`.
 *
 * @param text - Document or script header to search.
 */
const appScripts = (text: string): string[] =>
  text
    .split('\n')
    .filter(
      (line) => line.includes('docker compose') && / (exec|run) /.test(line),
    )
    .flatMap((line) => APP_SCRIPT.exec(line)?.slice(1) ?? []);

/** The `prod` stage of the Dockerfile, up to the next `FROM`. */
const prodStage = (): string => {
  const dockerfile = read('Dockerfile');
  const start = dockerfile.indexOf('AS prod');
  const next = dockerfile.indexOf('\nFROM ', start);

  return dockerfile.slice(start, next === -1 ? undefined : next);
};

/** Paths the `prod` stage copies from the build context. */
const copiedPaths = (): string[] =>
  prodStage()
    .split('\n')
    .filter((line) => line.startsWith('COPY ') && !line.includes('--from'))
    .flatMap((line) =>
      line
        .split(/\s+/)
        .slice(1, -1)
        .filter((token) => !token.startsWith('--'))
        .map((token) => token.replace(/^\.\//, '').replace(/\/$/, '')),
    );

const isCopied = (file: string, copied: string[]): boolean =>
  copied.some((path) => file === path || file.startsWith(`${path}/`));

/**
 * Resolves a script and everything it imports by relative path.
 *
 * @param entry - Repo-relative path of the script.
 * @returns Repo-relative paths of the script and its local imports.
 */
const closure = (entry: string, seen = new Set<string>()): Set<string> => {
  if (seen.has(entry)) return seen;

  seen.add(entry);

  const source = read(entry);
  const specifiers = [
    ...source.matchAll(/(?:from|import)\s+['"](\.{1,2}\/[^'"]+)['"]/g),
  ].flatMap((match) => match.slice(1));

  for (const specifier of specifiers) {
    const target = relative(ROOT, resolve(ROOT, dirname(entry), specifier));

    if (existsSync(join(ROOT, target))) closure(target, seen);
  }

  return seen;
};

const documented = [
  ...new Set([
    ...PRODUCTION_DOCS.flatMap((doc) => appScripts(read(doc))),
    ...scriptFiles().flatMap((file) => appScripts(read(file))),
  ]),
]
  .filter((script) => !DEV_ONLY.includes(script))
  .sort();

describe('production CLIs documented on app', () => {
  it('finds every known app-side CLI in the docs', () => {
    for (const script of KNOWN) assert.ok(documented.includes(script), script);
  });

  it('keeps the whole scripts directory and the privileged CLIs out of prod', () => {
    const copied = copiedPaths();

    assert.ok(!copied.includes('.') && !copied.includes('scripts'));
    assert.ok(!copied.some((path) => /^scripts\/(admin|db)\b/.test(path)));
  });

  for (const script of documented) {
    describe(script, () => {
      const files = [...closure(script)];

      it('and everything it imports ships in the prod image', () => {
        const copied = copiedPaths();
        const missing = files.filter((file) => !isCopied(file, copied));

        assert.deepEqual(missing, []);
      });

      it('needs no migrator or read-only credential', () => {
        const offenders = files.filter(
          (file) =>
            file.startsWith('scripts/') &&
            /POSTGRES_(MIGRATOR|READONLY)_/.test(read(file)),
        );

        assert.deepEqual(offenders, []);
      });
    });
  }
});
