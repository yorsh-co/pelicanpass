import { parseTable, unguard } from './csv.ts';

/** A survey question, as the report needs it. */
export interface Question {
  id: string;
  /** Plain text. */
  label: string;
  type: 'rating' | 'yes-no' | 'text';
}

/** An answer: rating, yes-no or text by question type; `null` if unanswered. */
export type Answer = number | boolean | string | null;

/** One submitted response. Carries no response id. */
export interface SurveyResponse {
  /** `YYYY-MM-DD`. */
  submittedOn: string | null;
  answers: Record<string, Answer>;
}

/** One audience's parsed survey. */
export interface SurveyData {
  /** Questions found in the file, in column order. */
  questions: Question[];
  responses: SurveyResponse[];
}

const FIXED = [
  'response_id',
  'submitted_on',
  'survey_version',
  'other_answers',
];
const REQUIRED = ['response_id', 'submitted_on'];

const isRating = (value: string): boolean => {
  const n = Number(value);

  return /^\d+$/.test(value) && n >= 1 && n <= 10;
};

/** Guesses the type of a column the caller has no definition for. */
const inferType = (values: string[]): Question['type'] => {
  const filled = values.filter((value) => value !== '');

  if (filled.length === 0) return 'text';
  if (filled.every(isRating)) return 'rating';
  if (filled.every((value) => value === 'yes' || value === 'no')) {
    return 'yes-no';
  }

  return 'text';
};

/**
 * Parses a survey export (`survey-participant.csv` or `survey-volunteer.csv`).
 *
 * A column that is neither fixed nor in `questions` is kept, with its type
 * inferred from the values and its id as label. Questions absent from the file
 * are absent from the result. `other_answers` is ignored.
 *
 * @param text - The CSV contents.
 * @param questions - Known question definitions.
 * @throws Error with a pt-BR message when the file is not a survey export or a
 * cell cannot be read; the message is meant for the user.
 */
export const parseSurveyCsv = (
  text: string,
  questions: readonly Question[],
): SurveyData => {
  const { header, records } = parseTable(text);
  const missing = REQUIRED.filter((name) => !header.includes(name));

  if (missing.length > 0) {
    throw new Error(
      `Arquivo de pesquisa inválido: faltam as colunas ${missing.join(', ')}.`,
    );
  }
  const known = new Map(questions.map((q) => [q.id, q]));
  const found: Question[] = header
    .filter((name) => !FIXED.includes(name))
    .map(
      (id) =>
        known.get(id) ?? {
          id,
          label: id,
          type: inferType(records.map((r) => unguard(r[id] ?? ''))),
        },
    );

  const responses = records.map((record, index): SurveyResponse => {
    const answers: Record<string, Answer> = {};

    for (const { id, type } of found) {
      const raw = unguard(record[id] ?? '');
      const fail = (): Error =>
        new Error(
          `Arquivo de pesquisa inválido: coluna ${id}, linha ${String(index + 2)}.`,
        );

      if (raw === '') answers[id] = null;
      else if (type === 'text') answers[id] = raw;
      else if (type === 'rating') {
        if (!isRating(raw)) throw fail();
        answers[id] = Number(raw);
      } else {
        if (raw !== 'yes' && raw !== 'no') throw fail();
        answers[id] = raw === 'yes';
      }
    }
    const submittedOn = (record.submitted_on ?? '').trim();

    return { submittedOn: submittedOn === '' ? null : submittedOn, answers };
  });

  return { questions: found, responses };
};

/** Follow-ups whose id does not follow the `<id>_comment` convention. */
const FOLLOW_UPS: Readonly<Record<string, string>> = {
  why_not_invite: 'would_invite',
};

/**
 * Maps each follow-up text question to the question it explains.
 *
 * A text question `<id>_comment` follows `<id>`, as does any text question
 * listed in `FOLLOW_UPS`. The parent must be present and not a text question;
 * other questions are left out.
 *
 * @param questions - The survey's questions.
 */
export const followUpParents = (
  questions: readonly Question[],
): Map<string, Question> => {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const parents = new Map<string, Question>();

  for (const { id, type } of questions) {
    if (type !== 'text') continue;
    const parentId = id.endsWith('_comment')
      ? id.slice(0, -'_comment'.length)
      : FOLLOW_UPS[id];
    const parent = parentId === undefined ? undefined : byId.get(parentId);

    if (parent !== undefined && parent.type !== 'text') parents.set(id, parent);
  }

  return parents;
};
