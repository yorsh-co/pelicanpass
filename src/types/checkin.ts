/** Steps of the check-in flow, in the order an attendee moves through them. */
export type CheckinStep = 'init' | 'ticket' | 'verification' | 'qr' | 'success';

/** Which steps of the check-in flow the attendee has cleared. */
export interface CheckinProgress {
  ticket: boolean;
  verified: boolean;
  qr: boolean;
}

/** Per-step failure counters, used to decide when a captcha is required. */
export interface CheckinFailedAttempts {
  ticket: number;
  verification: number;
  qr: number;
}
