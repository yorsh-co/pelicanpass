import type { AttendeeRole } from './attendee.ts';

/**
 * Fields every question carries, whatever its type.
 *
 * `label` and `hint` are inline HTML, rendered from the Markdown source at
 * boot. They are trusted: the source is a file in the repository.
 */
interface SurveyQuestionBase {
  /** Stable key: the `jsonb` key an answer is stored under and its CSV header. */
  id: string;
  required: boolean;
  label: string;
  hint: string | null;
}

/** One question of a questionnaire, as parsed from its Markdown file. */
export type SurveyQuestion =
  | (SurveyQuestionBase & { type: 'rating' })
  | (SurveyQuestionBase & { type: 'yes-no' })
  | (SurveyQuestionBase & { type: 'text'; maxLength: number });

/** One audience's questionnaire in one locale. */
export interface SurveyDefinition {
  /**
   * Covers wording as well as structure. Stored on each response, so an
   * export says which wording an answer was given to.
   */
  version: string;

  /**
   * Covers only what makes an answer valid: ids, types, required flags and
   * max-lengths. A form submitted under a different one is stale.
   */
  structureVersion: string;

  /** Inline HTML. */
  title: string;

  /** Block HTML, or `null` when the file has no intro. */
  intro: string | null;

  questions: SurveyQuestion[];
}

/**
 * Both audiences' questionnaires in one locale. `volunteer` is `null` when no
 * volunteer file exists. Whether a form is live is `env.survey.enabled`, not
 * this.
 */
export interface SurveyDefinitions {
  participant: SurveyDefinition;
  volunteer: SurveyDefinition | null;
}

/**
 * An administrator's override of the schedule. `null`, stored or absent,
 * leaves the schedule in charge.
 */
export type SurveyOverride = 'open' | 'closed';

/** Whether the shared window is open, and what decided it. */
export interface SurveyState {
  open: boolean;

  /**
   * `disabled` when both audiences are switched off in `.env`, `override`
   * when an administrator forced it, `schedule` otherwise.
   */
  reason: 'disabled' | 'override' | 'schedule';
}

/**
 * Answers as stored in `survey_responses.answers`, keyed by question id: a
 * rating's integer, a yes-or-no's boolean, a text answer's trimmed string.
 * Unanswered questions are absent.
 */
export type SurveyAnswers = Record<string, number | boolean | string>;

/** What a submit writes, once the service has checked it. */
export interface PreparedResponse {
  audience: AttendeeRole;
  version: string;
  answers: SurveyAnswers;
}

/** One audience, as the administrator's page shows it. */
export interface SurveyAudienceOverview {
  /** Its `.env` switch. */
  enabled: boolean;

  /** Whether a questions file is deployed for it. */
  hasQuestions: boolean;

  responses: number;
}

/** Everything `/admin/survey` shows. */
export interface SurveyOverview {
  state: SurveyState;

  /** The stored override, for the control's current choice. */
  override: SurveyOverride | null;

  opensAt: number | null;
  closesAt: number | null;
  audiences: Record<AttendeeRole, SurveyAudienceOverview>;
}
