/**
 * Fails when a questionnaire file under src/web/content cannot be served.
 *
 * Runs exactly the checks the application runs at boot, by loading the module
 * that runs them, so a malformed file fails `npm run check` rather than the
 * deploy. It reports every problem in every file, not just the first:
 *
 * - `pt-BR/survey-participant.md` is missing;
 * - a file departs from the grammar in docs/features/survey.md § The questions files;
 * - a translation's ids, order, types, required flags or max-lengths differ
 *   from its pt-BR file's;
 * - a translated `survey-volunteer.md` exists with no pt-BR one.
 *
 * Usage:
 *   node scripts/survey/check.ts
 */

import type { SurveyDefinitionError } from '../../src/modules/survey/survey.definition.ts';

try {
  const { surveyFor } =
    await import('../../src/modules/survey/survey.definition.ts');

  const participant = surveyFor('participant');
  const volunteer = surveyFor('volunteer');

  console.log(
    `✓ survey check passed (participant: ${String(participant?.questions.length)} questions, volunteer: ${
      volunteer ? `${String(volunteer.questions.length)} questions` : 'none'
    })`,
  );
} catch (error) {
  // Matched by name: a module that throws while loading exports nothing, the
  // error class included.
  if (!(error instanceof Error) || error.name !== 'SurveyDefinitionError') {
    throw error;
  }

  for (const problem of (error as SurveyDefinitionError).problems) {
    console.error(`survey: ${problem}`);
  }

  console.error(
    'survey: see "Edit the questionnaire" in docs/development/copy-management.md',
  );
  process.exit(1);
}
