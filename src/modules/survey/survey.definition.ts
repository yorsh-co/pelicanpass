import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import { marked } from 'marked';

import type { Token, Tokens } from 'marked';

import { COPY_DEFAULTS } from '../../constants/copy-defaults.ts';
import { BASE_LOCALE, LOCALES } from '../../i18n/locales.ts';
import { fillCopyPlaceholders } from '../../shared/utils/copy-placeholders.ts';
import { isSafeUrl, safeMarked } from '../../shared/utils/markdown.ts';

import type { Locale } from '../../i18n/locales.ts';
import type { AttendeeRole } from '../../types/attendee.ts';
import type {
  SurveyDefinition,
  SurveyDefinitions,
  SurveyQuestion,
} from '../../types/survey.ts';

/**
 * The questionnaires, read from `src/web/content/<locale>/survey-<audience>.md`.
 *
 * The questions are Markdown so they can be edited without touching code, on
 * the precedent the privacy notice sets. The grammar and the editing rules are
 * in `docs/features/survey.md` § The questions files.
 *
 * Parsed once, when this module is first imported: the files ship inside the
 * image and cannot change under a running process. Every problem in every file
 * is collected before the load throws, so `scripts/survey/check.ts` — which
 * does nothing but import this module — reports them all in one run.
 *
 * The text is rendered with `safeMarked`, which escapes raw HTML and drops
 * links whose address is not relative, `http`, `https` or `mailto`. The parser
 * also refuses raw HTML, images and such links outright, so a file that
 * relies on them fails the boot rather than rendering differently.
 */

/** A questionnaire as its file describes it, before versions are derived. */
export type ParsedSurvey = Omit<
  SurveyDefinition,
  'version' | 'structureVersion'
>;

/** Raised for a questionnaire file that cannot be served. */
export class SurveyDefinitionError extends Error {
  /** One line per problem, each naming its file and, if any, its question. */
  readonly problems: readonly string[];

  /**
   * @param problems - What is wrong, one line each.
   */
  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'SurveyDefinitionError';
    this.problems = problems;
  }
}

const AUDIENCES: readonly AttendeeRole[] = ['participant', 'volunteer'];

const QUESTION_TYPES = ['rating', 'yes-no', 'text'] as const;
const PROPERTY_KEYS = ['id', 'type', 'required', 'max-length'] as const;

const ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const PROPERTY_PATTERN = /^([a-z-]+):\s*(.*)$/;
const COMMENT_PATTERN = /^<!--[\s\S]*-->\s*$/;

const DEFAULT_MAX_LENGTH = 500;
const MAX_MAX_LENGTH = 1000;

/**
 * Most text one submission may carry, summed over a file's text questions.
 *
 * The API parses JSON with `express.json({ limit: '10kb' })`. A character is
 * at most four bytes of UTF-8, so 2000 of them is 8 KB and leaves room for the
 * rest of the body. Past this, a long answer would be refused at the door with
 * a `413` the card can only report as a generic failure.
 */
const MAX_TEXT_TOTAL = 2000;

const CONTENT_DIR = new URL('../../web/content/', import.meta.url);

/** Reports a departure from the grammar, naming the question if there is one. */
type Fail = (problem: string, heading?: string) => never;

/**
 * Narrows a property value to a question type.
 *
 * @param value - The `type` property as written.
 */
const isQuestionType = (value: string): value is SurveyQuestion['type'] =>
  (QUESTION_TYPES as readonly string[]).includes(value);

/**
 * Names a block the grammar does not allow, for an error message.
 *
 * @param token - The offending block.
 */
const describe = (token: Token): string => {
  switch (token.type) {
    case 'heading':
      return `a level-${String((token as Tokens.Heading).depth)} heading`;
    case 'html':
      return 'raw HTML';
    case 'code':
      return 'a code block';
    case 'hr':
      return 'a horizontal rule';
    default:
      return `a ${token.type}`;
  }
};

/**
 * Finds an image, raw HTML or a link to a disallowed address among inline
 * tokens, at any depth.
 *
 * @param tokens - Inline tokens of a heading or paragraph.
 * @returns What was found, or `null` if the text is plain Markdown.
 */
const forbiddenInline = (tokens: Token[]): string | null => {
  for (const token of tokens) {
    if (token.type === 'image') return 'an image';
    if (token.type === 'html') return 'raw HTML';

    if (token.type === 'link' && !isSafeUrl((token as Tokens.Link).href)) {
      return 'a link to a disallowed address';
    }

    if ('tokens' in token && Array.isArray(token.tokens)) {
      const nested = forbiddenInline(token.tokens);

      if (nested) return nested;
    }
  }

  return null;
};

/**
 * Parses one questionnaire file.
 *
 * Pure: it reads nothing and knows nothing of locales, so the loader can run
 * it over every file and compare the results.
 *
 * @param source - The file's contents. Its `{name}` copy placeholders are
 *   filled from the copy defaults before parsing.
 * @param file - Repo-relative path, used only in error messages.
 * @returns The title, intro and questions, with labels and hints rendered.
 * @throws {Error} On a copy placeholder with no default.
 * @throws {SurveyDefinitionError} On the first departure from the grammar,
 *   naming the file and, where there is one, the question's heading.
 */
export const parseSurvey = (source: string, file: string): ParsedSurvey => {
  const fail: Fail = (problem, heading) => {
    throw new SurveyDefinitionError([
      heading === undefined
        ? `${file}: ${problem}`
        : `${file}: "## ${heading}": ${problem}`,
    ]);
  };

  const render = (
    token: Tokens.Heading | Tokens.Paragraph,
    what: string,
    heading?: string,
  ): string => {
    const found = forbiddenInline(token.tokens);

    if (found) fail(`${what} contains ${found}`, heading);

    return safeMarked.parseInline(token.text, { async: false });
  };

  const ids = new Set<string>();

  const parseQuestion = ([
    heading,
    list,
    hint,
    extra,
  ]: Token[]): SurveyQuestion => {
    const name = (heading as Tokens.Heading).text;

    if (name.trim() === '') fail('a question has an empty "##" heading');

    const label = render(heading as Tokens.Heading, 'the label', name);

    if (list?.type !== 'list') {
      fail('must be followed by its property list', name);
    }

    const { ordered, items } = list as Tokens.List;

    if (ordered) fail('the property list must be bulleted, not numbered', name);

    const properties = new Map<string, string>();

    for (const item of items) {
      const plain =
        !item.task && item.tokens.every((token) => token.type === 'text');
      const match = plain ? PROPERTY_PATTERN.exec(item.text.trim()) : null;

      if (!match) {
        fail(`property "${item.text}" is not a plain "key: value"`, name);
      }

      const [, key = '', value = ''] = match;

      if (!(PROPERTY_KEYS as readonly string[]).includes(key)) {
        fail(`unknown property "${key}"`, name);
      }

      if (properties.has(key)) fail(`property "${key}" is given twice`, name);

      properties.set(key, value.trim());
    }

    if (hint && hint.type !== 'paragraph') {
      fail(`has ${describe(hint)} after its property list`, name);
    }

    if (extra) {
      fail(
        extra.type === 'paragraph'
          ? 'has more than one hint paragraph'
          : `has ${describe(extra)} after its hint`,
        name,
      );
    }

    const id = properties.get('id');
    const type = properties.get('type');
    const required = properties.get('required');
    const maxLength = properties.get('max-length');

    if (id === undefined) fail('is missing "id"', name);
    if (type === undefined) fail('is missing "type"', name);
    if (required === undefined) fail('is missing "required"', name);

    if (!ID_PATTERN.test(id)) {
      fail(`id "${id}" must match ${ID_PATTERN.source}`, name);
    }

    if (ids.has(id)) fail(`id "${id}" is already used in this file`, name);

    ids.add(id);

    if (!isQuestionType(type)) {
      fail(`type "${type}" must be one of ${QUESTION_TYPES.join(', ')}`, name);
    }

    if (required !== 'yes' && required !== 'no') {
      fail(`required "${required}" must be yes or no`, name);
    }

    const base = {
      id,
      required: required === 'yes',
      label,
      hint: hint ? render(hint as Tokens.Paragraph, 'the hint', name) : null,
    };

    if (type !== 'text') {
      if (maxLength !== undefined) {
        fail('"max-length" applies only to text questions', name);
      }

      return { ...base, type };
    }

    if (maxLength === undefined) {
      return { ...base, type, maxLength: DEFAULT_MAX_LENGTH };
    }

    const limit = /^\d+$/.test(maxLength) ? Number(maxLength) : NaN;

    if (!(limit >= 1 && limit <= MAX_MAX_LENGTH)) {
      fail(
        `max-length "${maxLength}" must be 1 to ${String(MAX_MAX_LENGTH)}`,
        name,
      );
    }

    return { ...base, type, maxLength: limit };
  };

  let title: string | null = null;
  const intro: Tokens.Paragraph[] = [];

  // Each question runs from its `##` to the next one.
  const sections: Token[][] = [];

  for (const token of marked.lexer(
    fillCopyPlaceholders(source, COPY_DEFAULTS, file),
  )) {
    const section = sections.at(-1);

    // Comments carry the editing notes and are not part of the survey.
    if (
      token.type === 'space' ||
      (token.type === 'html' && COMMENT_PATTERN.test(token.raw))
    ) {
      continue;
    }

    if (token.type === 'heading' && token.depth === 2) {
      sections.push([token]);
    } else if (section) {
      section.push(token);
    } else if (token.type === 'heading' && token.depth === 1) {
      if (title !== null) fail('has more than one "#" title');
      if (intro.length > 0) fail('has text before its "#" title');

      title = render(token as Tokens.Heading, 'the title');
    } else if (token.type === 'paragraph' && title !== null) {
      const found = forbiddenInline((token as Tokens.Paragraph).tokens);

      if (found) fail(`the intro contains ${found}`);

      intro.push(token as Tokens.Paragraph);
    } else {
      fail(`has ${describe(token)} where only the title and intro may go`);
    }
  }

  if (!title) fail('has no "#" title');
  if (sections.length === 0) fail('has no questions');

  const questions = sections.map(parseQuestion);

  const textTotal = questions.reduce(
    (total, question) =>
      question.type === 'text' ? total + question.maxLength : total,
    0,
  );

  if (textTotal > MAX_TEXT_TOTAL) {
    fail(
      `text questions allow ${String(textTotal)} characters in all, more than the ${String(MAX_TEXT_TOTAL)} one submission can carry; lower their max-length`,
    );
  }

  return {
    title,
    intro: intro.length > 0 ? safeMarked.parser(intro) : null,
    questions,
  };
};

/**
 * What makes an answer valid for a question, in a fixed order.
 *
 * @param question - The question to reduce.
 */
const structureOf = (question: SurveyQuestion) => [
  question.id,
  question.type,
  question.required,
  question.type === 'text' ? question.maxLength : null,
];

/**
 * First 12 hex characters of the SHA-256 of a value's JSON.
 *
 * Every value hashed here is an array built in a fixed order, so its JSON is
 * canonical without sorting keys.
 *
 * @param value - Array to hash.
 */
const digest = (value: unknown[]): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/**
 * Derives a questionnaire's versions from its questions, so nobody has to
 * remember to bump them.
 *
 * @param questions - The pt-BR questions, in file order.
 * @returns `structureVersion`, over ids, types, required flags and
 *   max-lengths, and `version`, over those plus labels and hints.
 */
export const deriveVersions = (
  questions: SurveyQuestion[],
): Pick<SurveyDefinition, 'version' | 'structureVersion'> => ({
  structureVersion: digest(questions.map(structureOf)),
  version: digest(
    questions.map((question) => [
      ...structureOf(question),
      question.label,
      question.hint,
    ]),
  ),
});

/**
 * Compares a translation's structure with its pt-BR file's.
 *
 * @param base - The pt-BR questions.
 * @param translation - The translated questions.
 * @returns The first difference, or `null` when only the text differs.
 */
export const sameStructure = (
  base: SurveyQuestion[],
  translation: SurveyQuestion[],
): string | null => {
  for (const [index, expected] of base.entries()) {
    const actual = translation[index];

    if (!actual) return `is missing pt-BR's question "${expected.id}"`;

    if (
      JSON.stringify(structureOf(actual)) !==
      JSON.stringify(structureOf(expected))
    ) {
      return `question ${String(index + 1)} ("${actual.id}") differs from pt-BR's "${expected.id}" in id, type, required or max-length`;
    }
  }

  const extra = translation[base.length];

  return extra ? `has question "${extra.id}", which pt-BR does not` : null;
};

/**
 * Repo-relative path of a questionnaire file, for error messages.
 *
 * @param locale - Locale directory.
 * @param audience - Audience the file is for.
 */
const pathOf = (locale: Locale, audience: AttendeeRole): string =>
  `src/web/content/${locale}/survey-${audience}.md`;

/**
 * Reads a questionnaire file.
 *
 * @param locale - Locale directory.
 * @param audience - Audience the file is for.
 * @returns Its contents, or `null` when there is no such file.
 */
const readSource = (locale: Locale, audience: AttendeeRole): string | null => {
  const url = new URL(`${locale}/survey-${audience}.md`, CONTENT_DIR);

  return existsSync(url) ? readFileSync(url, 'utf8') : null;
};

/**
 * Reads and checks every questionnaire file.
 *
 * pt-BR alone decides whether an audience has a survey, and its questions
 * alone decide both versions, so an edit to a translation changes neither. A
 * locale without its own file is served pt-BR's, as the privacy notice is.
 *
 * @returns Both audiences' definitions for every locale.
 * @throws {SurveyDefinitionError} Listing every problem found: a missing
 *   pt-BR participant file, a file that does not parse, a translation whose
 *   structure differs from pt-BR's, or a translation with no pt-BR file.
 */
const loadDefinitions = (): Record<Locale, SurveyDefinitions> => {
  const problems: string[] = [];

  const parse = (
    source: string,
    locale: Locale,
    audience: AttendeeRole,
  ): ParsedSurvey | null => {
    try {
      return parseSurvey(source, pathOf(locale, audience));
    } catch (error) {
      if (!(error instanceof SurveyDefinitionError)) throw error;

      problems.push(...error.problems);

      return null;
    }
  };

  const base: Record<AttendeeRole, SurveyDefinition | null> = {
    participant: null,
    volunteer: null,
  };

  const baseExists = new Set<AttendeeRole>();

  for (const audience of AUDIENCES) {
    const source = readSource(BASE_LOCALE, audience);

    if (source === null) {
      if (audience === 'participant') {
        problems.push(
          `${pathOf(BASE_LOCALE, audience)}: is missing, and every deployment needs a participant questionnaire`,
        );
      }

      continue;
    }

    baseExists.add(audience);

    const parsed = parse(source, BASE_LOCALE, audience);

    if (parsed) {
      base[audience] = { ...parsed, ...deriveVersions(parsed.questions) };
    }
  }

  const byLocale = {} as Record<
    Locale,
    Record<AttendeeRole, SurveyDefinition | null>
  >;

  for (const locale of LOCALES) {
    byLocale[locale] = { ...base };

    if (locale === BASE_LOCALE) continue;

    for (const audience of AUDIENCES) {
      const source = readSource(locale, audience);

      if (source === null) continue;

      const parsed = parse(source, locale, audience);

      if (!baseExists.has(audience)) {
        problems.push(
          `${pathOf(locale, audience)}: has no pt-BR file at ${pathOf(BASE_LOCALE, audience)}, which alone decides whether this audience has a survey`,
        );

        continue;
      }

      const baseline = base[audience];

      // A pt-BR file that failed to parse is already reported.
      if (!parsed || !baseline) continue;

      const mismatch = sameStructure(baseline.questions, parsed.questions);

      if (mismatch) {
        problems.push(`${pathOf(locale, audience)}: ${mismatch}`);

        continue;
      }

      byLocale[locale][audience] = {
        ...parsed,
        version: baseline.version,
        structureVersion: baseline.structureVersion,
      };
    }
  }

  if (problems.length > 0) throw new SurveyDefinitionError(problems);

  return Object.fromEntries(
    LOCALES.map((locale) => {
      const { participant, volunteer } = byLocale[locale];

      // Narrows the type only: a missing or unparseable participant file is a
      // problem above, and problems have already thrown.
      if (!participant) throw new SurveyDefinitionError(['unreachable']);

      return [locale, { participant, volunteer }];
    }),
  ) as Record<Locale, SurveyDefinitions>;
};

const DEFINITIONS = loadDefinitions();

/**
 * The questionnaire an audience is shown.
 *
 * The one place the rest of the code asks whether an audience has a survey,
 * and what it is.
 *
 * @param role - The attendee's role.
 * @param locale - Locale to render in. Versions are the same in every locale.
 * @returns The definition, or `null` when the audience has no survey.
 */
export const surveyFor = (
  role: AttendeeRole,
  locale: Locale = BASE_LOCALE,
): SurveyDefinition | null => DEFINITIONS[locale][role];
