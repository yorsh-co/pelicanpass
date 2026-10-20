import type { Attendee } from './checkin.ts';
import type { Question, SurveyData } from './survey.ts';

/** `localStorage` key holding the viewer's explicit theme, `light` or `dark`. */
export const THEME_STORAGE_KEY = 'pelicanpass-report-theme';

/** Survey questions per audience; `volunteer` is `null` without a volunteer survey. */
export interface Definitions {
  participant: Question[];
  volunteer: Question[] | null;
}

/** Everything the page shows that comes from the event. */
export interface ReportData {
  attendees: Attendee[];
  surveys: { participant: SurveyData | null; volunteer: SurveyData | null };
  /** Trusted HTML rendered at build time, or `null` without a summary. */
  resumoHtml: string | null;
  /** ISO timestamp. */
  generatedAt: string;
}

/** The JSON embedded in the page. `data` is `null` in the template. */
export interface ReportPayload {
  definitions: Definitions;
  /** Church that hosts the event, as written in the `church` column. */
  hostChurch: string | null;
  data: ReportData | null;
}
