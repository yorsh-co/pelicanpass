import store from './store.ts';
import { isAudienceRole } from '../../../../../../constants/audience.ts';

import type { AttendeeRole } from '../../../../../../types/attendee.ts';

export { isAudienceRole };

/**
 * Ensures that dataset.audience is populated
 * in the layout body element dataset tag.
 *
 * Returns the audience.
 *
 * **The result is always one of the known audiences**, falling back to
 * `participant`. Callers pass the unvalidated `?audience=` query parameter,
 * and the result reaches both `document.body.dataset` and — via the logout
 * handler — `location.href`, where an unrecognised value such as
 * `x%26foo=bar` would append a query parameter of the caller's choosing to
 * the redirect.
 *
 * @param audience - Overrides the audience already in state.
 */
export const ensureAudience = (
  audience: string | null = null,
): AttendeeRole => {
  const { audienceHint, session } = store.getState();

  // Truthiness, not nullishness: `?audience=` arrives as an empty string and
  // has to fall through to the next candidate the same way a missing one does.
  /* eslint-disable @typescript-eslint/prefer-nullish-coalescing */
  const candidate =
    audience || session?.attendeeRole || audienceHint || 'participant';
  /* eslint-enable @typescript-eslint/prefer-nullish-coalescing */

  const resultAudience = isAudienceRole(candidate) ? candidate : 'participant';

  document.body.dataset.audience = resultAudience;

  return resultAudience;
};
