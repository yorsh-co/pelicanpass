import type { AttendeeRole } from '../../../../types/attendee.ts';
import type { AttendeePreview } from '../../../../types/session.ts';
import type {
  CheckinProgress,
  CheckinStep,
} from '../../../../types/checkin.ts';

/**
 * The browser's view of the wire format, mirroring what
 * `src/modules/checkin/checkin.controller.ts` serialises.
 *
 * The leaf types are imported from the backend rather than restated: they
 * describe one contract, and a type-only import erases before bundling. The
 * envelope itself is declared here because the controller assembles it around
 * the service's response, and the service's own interfaces live in a module
 * with runtime code that cannot be type-checked against the browser lib.
 */

/** The part of the check-in session the browser is allowed to see. */
export interface CheckinSessionView {
  progress: CheckinProgress;
  attendeePreview: Partial<AttendeePreview>;
  attendeeRole: AttendeeRole | null;

  /** Sent only on the response that completes the check-in. */
  checkinNumber?: number | null;
}

/** Where the flow stands once a step has been applied. */
export interface CheckinResponseMeta {
  nextStep?: CheckinStep;
  captchaRequired?: boolean;
}

/**
 * Envelope every check-in endpoint responds with.
 *
 * Every member is optional even though the controller always sends them. This
 * is a description of unvalidated network data, not of the controller, and the
 * callers' `if (!nextStep)` guards only mean something if the type admits the
 * response that would trip them.
 */
export interface CheckinApiResponse {
  success?: boolean;
  code?: string;
  meta?: CheckinResponseMeta;
  data?: {
    session?: CheckinSessionView;
  };
}
