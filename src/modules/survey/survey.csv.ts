import { FORMULA_START } from '../../constants/csv.ts';

import type { SurveyAnswers, SurveyQuestion } from '../../types/survey.ts';

/** One stored response, as `survey_export` projects it for an export. */
export interface SurveyExportRow {
  response_id: string;

  /** `YYYY-MM-DD`, read as text so no `Date` round-trip can move the day. */
  submitted_on: string;

  survey_version: string;
  answers: SurveyAnswers;
}

const NEEDS_QUOTES = /[",\r\n]/;

/**
 * One cell, made inert and quoted as RFC 4180 requires.
 *
 * @param value - The cell's text.
 */
const cell = (value: string): string => {
  const inert = FORMULA_START.test(value) ? `'${value}` : value;

  return NEEDS_QUOTES.test(inert) ? `"${inert.replaceAll('"', '""')}"` : inert;
};

/**
 * An answer as a cell's text: a rating's number, `yes` or `no`, the text as
 * given, or empty when the question was not answered.
 *
 * @param value - The stored answer, if any.
 */
const answerText = (value: SurveyAnswers[string] | undefined): string => {
  if (value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';

  return String(value);
};

/**
 * Builds one audience's CSV.
 *
 * Shared by the administrator's download and the teardown export, so the two
 * cannot drift apart in columns or in the formula guard.
 *
 * Columns are `response_id`, `submitted_on`, `survey_version`, one per question
 * in the file's order, then `other_answers`: JSON of any answer the current
 * questions no longer define, so removing a question after the survey opened
 * loses nothing. An audience whose file has gone passes no questions, and every
 * answer lands there.
 *
 * UTF-8 with a byte-order mark, so a spreadsheet opened by double-click shows
 * the accents rather than guessing another encoding. CRLF line endings.
 *
 * @param rows - The audience's responses, in export order.
 * @param questions - That audience's questions, or `[]` if it has none.
 * @returns The file's contents.
 */
export const buildSurveyCsv = (
  rows: readonly SurveyExportRow[],
  questions: readonly SurveyQuestion[],
): string => {
  const ids = questions.map((question) => question.id);
  const known = new Set(ids);

  const header = [
    'response_id',
    'submitted_on',
    'survey_version',
    ...ids,
    'other_answers',
  ];

  const lines = rows.map((row) => {
    const other = Object.fromEntries(
      Object.entries(row.answers).filter(([id]) => !known.has(id)),
    );

    return [
      row.response_id,
      row.submitted_on,
      row.survey_version,
      ...ids.map((id) => answerText(row.answers[id])),
      Object.keys(other).length > 0 ? JSON.stringify(other) : '',
    ];
  });

  return (
    '﻿' +
    [header, ...lines].map((line) => line.map(cell).join(',')).join('\r\n') +
    '\r\n'
  );
};
