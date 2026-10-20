import type { AttendeeRole } from '../types/attendee.ts';
import type { SurveyOverview } from '../types/survey.ts';

/**
 * How one audience's questionnaire is doing, for the metrics panel.
 *
 * This module is imported by browser code, so it must stay free of Node
 * built-ins.
 */
export interface SurveyCoverageRow {
  audience: AttendeeRole;
  answered: number;
  checkedIn: number;

  /** Switched off in `.env`, or with no questions file deployed. */
  off: boolean;
}

/** What the metrics panel's questionnaire card shows. */
export interface SurveyCoverage {
  /** Responses across every audience, switched off or not. */
  total: number;
  rows: SurveyCoverageRow[];

  /** Whether the card has anything to say. */
  visible: boolean;
}

/**
 * Pairs each audience's responses with how many of them checked in.
 *
 * Responses can exceed check-ins: archiving an attendee drops them from the
 * check-in count and not from the answers already given. An audience with no
 * check-in row counts as zero.
 *
 * The volunteer row is left out while it is switched off and has no responses.
 * The card is not `visible` when every audience is switched off and nothing was
 * answered.
 *
 * @param overview - The questionnaire's overview.
 * @param checkins - The snapshot's check-in totals by role.
 */
export const surveyCoverage = (
  overview: SurveyOverview,
  checkins: readonly { attendeeRole: string; checkedIn: number }[],
): SurveyCoverage => {
  const rows = (['participant', 'volunteer'] as const)
    .map((audience): SurveyCoverageRow => {
      const { enabled, hasQuestions, responses } = overview.audiences[audience];

      return {
        audience,
        answered: responses,
        checkedIn:
          checkins.find((row) => row.attendeeRole === audience)?.checkedIn ?? 0,
        off: !enabled || !hasQuestions,
      };
    })
    .filter(
      (row) => row.audience === 'participant' || !row.off || row.answered > 0,
    );

  return {
    total: rows.reduce((sum, row) => sum + row.answered, 0),
    rows,
    visible: rows.some((row) => !row.off || row.answered > 0),
  };
};
