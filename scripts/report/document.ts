import { COPY_DEFAULTS } from '../../src/constants/copy-defaults.ts';

import { THEME_STORAGE_KEY } from './core/model.ts';

import type { ReportPayload } from './core/model.ts';
import type { Question } from './core/survey.ts';

/**
 * ECharts from the npm package on jsDelivr, a script host the artifact's CSP
 * allows. Must match the `echarts` devDependency, which supplies the types.
 */
export const ECHARTS_URL =
  'https://cdn.jsdelivr.net/npm/echarts@6.1.0/dist/echarts.min.js';

const JSON_ESCAPES: Readonly<Record<string, string>> = {
  '<': '\\u003c',
  '>': '\\u003e',
  '&': '\\u0026',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/**
 * Serialises a value as JSON that is safe inside a `<script>` element.
 *
 * `<`, `>` and `&` could end the element or open a comment; U+2028 and U+2029
 * are line terminators in older JavaScript. None occurs outside a string in
 * JSON, so escaping them there leaves the value unchanged.
 *
 * @param value - A JSON-serialisable value.
 */
export const escapeJson = (value: unknown): string =>
  JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (char) => JSON_ESCAPES[char] ?? char,
  );

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Reduces a question label, which is inline HTML from the repo's Markdown
 * renderer, to plain text.
 *
 * @param html - The label as rendered.
 */
export const labelToText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
      (match, dec, hex, name) => {
        if (typeof dec === 'string') return String.fromCodePoint(Number(dec));
        if (typeof hex === 'string') {
          return String.fromCodePoint(Number.parseInt(hex, 16));
        }

        return ENTITIES[String(name).toLowerCase()] ?? match;
      },
    )
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Converts parsed survey questions to the report's shape.
 *
 * @param questions - Questions as the app's survey parser returns them.
 */
export const toQuestions = (
  questions: readonly { id: string; label: string; type: Question['type'] }[],
): Question[] =>
  questions.map(({ id, label, type }) => ({
    id,
    label: labelToText(label),
    type,
  }));

/** The pieces of the page. */
export interface PageParts {
  /** Stylesheet text. */
  css: string;
  /** Bundled script text. */
  script: string;
  payload: ReportPayload;
}

/**
 * Applies a stored theme before first paint. The bundle runs only after
 * ECharts has loaded, so leaving this to it would flash the other theme.
 */
const THEME_BOOT = `<script>try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==='light'||t==='dark')document.documentElement.dataset.theme=t}catch(e){}</script>`;

/** Keeps a script from ending its own element or opening a comment. */
const inertScript = (script: string): string =>
  script.replace(/<(\/script|!--)/gi, '<\\$1');

/**
 * Builds the page body as an HTML fragment: title, styles, shell and scripts,
 * without document, head or body tags. This is the form the artifact host
 * wraps; {@link renderDocument} wraps it for standalone files.
 *
 * @param parts - Styles, script and embedded data.
 */
export const renderFragment = ({ css, script, payload }: PageParts): string =>
  [
    `<title>Relatório ${COPY_DEFAULTS.eventName}</title>`,
    '<meta name="claude:viewport-fit-sides" content="cover">',
    `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`,
    THEME_BOOT,
    '<div id="app"><div class="rp-boot" role="status">Carregando relatório…</div></div>',
    `<script src="${ECHARTS_URL}"></script>`,
    `<script id="report-data" type="application/json">${escapeJson(payload)}</script>`,
    `<script>${inertScript(script)}</script>`,
    '',
  ].join('\n');

/**
 * Wraps a fragment in a complete document.
 *
 * @param fragment - Output of {@link renderFragment}.
 */
export const renderDocument = (fragment: string): string =>
  [
    '<!doctype html>',
    '<html lang="pt-BR">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '</head>',
    '<body>',
    fragment,
    '</body>',
    '</html>',
    '',
  ].join('\n');
