/**
 * Builds the post-event report page.
 *
 * Two outputs from one source. `--template` writes an HTML fragment with no
 * data, to publish as an artifact; the CSVs are dropped onto the page and
 * parsed in the browser. Otherwise a standalone document is written with the
 * parsed model embedded, never the raw CSV, so ticket codes cannot leak.
 *
 * Usage:
 *   node scripts/report/build.ts --template [--host-church <name>] --out <file>
 *   node scripts/report/build.ts --checkin <csv> [--survey-participant <csv>]
 *     [--survey-volunteer <csv>] [--resumo <md>] [--host-church <name>]
 *     [--out <file>]
 *
 * The default output, `reports/relatorio.html`, is ignored by git: it holds
 * survey answers.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { argv, cwd, exit, stderr } from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import * as esbuild from 'esbuild';

import { parseSurvey } from '../../src/modules/survey/survey.definition.ts';
import { renderMarkdown } from '../../src/shared/utils/markdown.ts';

import { parseCheckin } from './core/checkin.ts';
import { parseSurveyCsv } from './core/survey.ts';
import { renderDocument, renderFragment, toQuestions } from './document.ts';

import type { Definitions, ReportPayload } from './core/model.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const path = (relative: string): string => `${ROOT}${relative}`;
const DEFAULT_OUT = 'reports/relatorio.html';

const USAGE = `uso:
  node scripts/report/build.ts --template [--host-church <nome>] --out <arquivo>
  node scripts/report/build.ts --checkin <csv> [--survey-participant <csv>]
    [--survey-volunteer <csv>] [--resumo <md>] [--host-church <nome>]
    [--out <arquivo>]`;

/** Reads a file named on the command line, naming the option on failure. */
const read = (option: string, file: string): string => {
  if (!existsSync(file)) {
    throw new Error(`--${option}: arquivo não encontrado: ${file}`);
  }

  return readFileSync(file, 'utf8');
};

/** Reads the questionnaire files the app serves. */
const loadDefinitions = (): Definitions => {
  const load = (audience: string): Definitions['participant'] | null => {
    const file = `src/web/content/pt-BR/survey-${audience}.md`;

    return existsSync(path(file))
      ? toQuestions(
          parseSurvey(readFileSync(path(file), 'utf8'), file).questions,
        )
      : null;
  };
  const participant = load('participant');

  if (participant === null) {
    throw new Error('questionário de participantes não encontrado.');
  }

  return { participant, volunteer: load('volunteer') };
};

/** Bundles the browser code and stylesheets into the two strings to inline. */
const buildAssets = async (): Promise<{ css: string; script: string }> => {
  const bundle = await esbuild.build({
    entryPoints: [path('scripts/report/page/main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    minify: true,
    target: 'es2022',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'warning',
  });
  const font = readFileSync(
    path('src/web/public/assets/fonts/libre-franklin-latin.woff2'),
  ).toString('base64');
  const fontFace = `@font-face {
  font-family: 'Libre Franklin';
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url('data:font/woff2;base64,${font}') format('woff2');
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}`;
  const css = [
    fontFace,
    readFileSync(path('src/web/public/css/base/variables.css'), 'utf8'),
    readFileSync(path('scripts/report/page/report.css'), 'utf8'),
    readFileSync(path('scripts/report/page/present/present.css'), 'utf8'),
  ].join('\n');

  return { css, script: bundle.outputFiles[0]?.text ?? '' };
};

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: argv.slice(2),
    options: {
      template: { type: 'boolean', default: false },
      checkin: { type: 'string' },
      'survey-participant': { type: 'string' },
      'survey-volunteer': { type: 'string' },
      resumo: { type: 'string' },
      'host-church': { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const hostChurch = values['host-church']?.trim() ?? null;

  if (hostChurch === '') {
    throw new Error('--host-church: informe o nome da igreja anfitriã.');
  }
  const definitions = loadDefinitions();
  let payload: ReportPayload;

  if (values.template) {
    const extra = [
      'checkin',
      'survey-participant',
      'survey-volunteer',
      'resumo',
    ];

    if (extra.some((name) => name in values)) {
      throw new Error('--template não aceita arquivos de dados.');
    }
    if (values.out === undefined) {
      throw new Error('--template exige --out <arquivo>.');
    }
    payload = { definitions, hostChurch, data: null };
  } else {
    if (values.checkin === undefined) {
      throw new Error('informe --checkin <csv> ou use --template.');
    }
    const survey = (
      option: 'survey-participant' | 'survey-volunteer',
      audience: 'participant' | 'volunteer',
    ) => {
      const file = values[option];
      const questions = definitions[audience];

      if (file === undefined) return null;
      if (questions === null) {
        throw new Error(
          `--${option}: não há questionário de ${audience === 'participant' ? 'participantes' : 'voluntários'}.`,
        );
      }

      return parseSurveyCsv(read(option, file), questions);
    };
    const resumo =
      values.resumo === undefined ? null : read('resumo', values.resumo);

    payload = {
      definitions,
      hostChurch,
      data: {
        attendees: parseCheckin(read('checkin', values.checkin)),
        surveys: {
          participant: survey('survey-participant', 'participant'),
          volunteer: survey('survey-volunteer', 'volunteer'),
        },
        resumoHtml: resumo === null ? null : renderMarkdown(resumo),
        generatedAt: new Date().toISOString(),
      },
    };
  }

  const fragment = renderFragment({ ...(await buildAssets()), payload });
  const out = resolve(values.out ?? DEFAULT_OUT);

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, values.template ? fragment : renderDocument(fragment));
  console.log(`relatório: ${relative(cwd(), out)}`);
};

try {
  await main();
} catch (error) {
  stderr.write(
    `relatório: ${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`,
  );
  exit(1);
}
