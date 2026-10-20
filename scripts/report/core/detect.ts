import { parseCheckin } from './checkin.ts';
import { parseTable } from './csv.ts';
import { parseSurveyCsv } from './survey.ts';

import type { Attendee } from './checkin.ts';
import type { Definitions } from './model.ts';
import type { SurveyData } from './survey.ts';

/** What a dropped file holds. */
export type FileKind =
  | { kind: 'checkin' }
  | { kind: 'survey'; audience: 'participant' | 'volunteer' };

/**
 * Tells what a CSV export is from its header alone.
 *
 * A check-in file has `attendee_role`; a survey has `response_id` and belongs
 * to the audience whose question ids the header shares most.
 *
 * @param text - The CSV contents.
 * @param definitions - Known questions per audience.
 * @throws Error with a pt-BR message when the file is neither, or the
 * audience of a survey cannot be told.
 */
export const classifyCsv = (
  text: string,
  definitions: Definitions,
): FileKind => {
  const { header } = parseTable(text);

  if (header.includes('attendee_role')) return { kind: 'checkin' };
  if (!header.includes('response_id')) {
    throw new Error(
      'Arquivo não reconhecido: esperava o CSV de check-in ou de pesquisa.',
    );
  }
  const overlap = (questions: Definitions['volunteer']): number =>
    questions?.filter((q) => header.includes(q.id)).length ?? 0;
  const participant = overlap(definitions.participant);
  const volunteer = overlap(definitions.volunteer);

  if (participant === volunteer) {
    throw new Error(
      'Não foi possível identificar o público da pesquisa (participantes ou voluntários).',
    );
  }

  return {
    kind: 'survey',
    audience: participant > volunteer ? 'participant' : 'volunteer',
  };
};

/** A file as read in the browser. */
export interface UploadedFile {
  name: string;
  text: string;
}

/** The parsed result of one to three uploads. */
export interface ParsedUploads {
  attendees: Attendee[];
  surveys: { participant: SurveyData | null; volunteer: SurveyData | null };
}

/**
 * Classifies and parses a set of uploads, in any order.
 *
 * @param files - One check-in file and up to one survey per audience.
 * @param definitions - Known questions per audience.
 * @throws Error with a pt-BR message naming the file at fault, or the missing
 * or repeated kind.
 */
export const parseUploads = (
  files: readonly UploadedFile[],
  definitions: Definitions,
): ParsedUploads => {
  const result: ParsedUploads = {
    attendees: [],
    surveys: { participant: null, volunteer: null },
  };
  let checkin = false;
  const seen = new Set<string>();

  for (const { name, text } of files) {
    try {
      const kind = classifyCsv(text, definitions);
      const key = kind.kind === 'checkin' ? 'checkin' : kind.audience;

      if (seen.has(key)) {
        throw new Error(
          key === 'checkin'
            ? 'Há mais de um arquivo de check-in.'
            : `Há mais de uma pesquisa de ${key === 'participant' ? 'participantes' : 'voluntários'}.`,
        );
      }
      seen.add(key);

      if (kind.kind === 'checkin') {
        result.attendees = parseCheckin(text);
        checkin = true;
      } else {
        const questions = definitions[kind.audience] ?? [];

        result.surveys[kind.audience] = parseSurveyCsv(text, questions);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(`${name}: ${message}`, { cause: error });
    }
  }
  if (!checkin) throw new Error('Falta o arquivo de check-in.');

  return result;
};
