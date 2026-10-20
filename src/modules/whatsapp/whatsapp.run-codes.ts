import type { AdminWhatsappMessages } from '../../i18n/generated/admin-whatsapp.messages.ts';

/**
 * Operator-facing names for the codes a WhatsApp run stores.
 *
 * `whatsapp_runs.stop_reason` and `whatsapp_sends.error_title` hold stable codes
 * written by the runner and the preview (`OPERATOR`, `FATAL_131031`,
 * `INVALID_PHONE_DDD`, …), and, for a failed send, the title Meta's webhook
 * reported. The codes are named from `admin-whatsapp`; Meta's own titles are
 * external English text and are shown as they arrived.
 *
 * Pure and free of Node APIs: the sender page renders these on the server and
 * its script renders them again on every poll.
 */

const STOP_REASONS: Record<string, (m: AdminWhatsappMessages) => string> = {
  OPERATOR: (m) => m.runReasonOperator(),
  OPERATOR_CANCELLED: (m) => m.runReasonOperatorCancelled(),
  RESTART: (m) => m.runReasonRestart(),
  AWAITING_INTERRUPTED: (m) => m.runReasonAwaitingInterrupted(),
  CIRCUIT_BREAKER: (m) => m.runReasonCircuitBreaker(),
  UNKNOWN_TEMPLATE: (m) => m.runReasonUnknownTemplate(),
};

const FAILURE_TITLES: Record<string, (m: AdminWhatsappMessages) => string> = {
  ALREADY_SENT: (m) => m.failureAlreadySent(),
  NO_RESPONSE: (m) => m.failureNoResponse(),
  INTERRUPTED: (m) => m.failureInterrupted(),
};

const PHONE_REASONS = ['empty', 'length', 'unqualified', 'ddd'] as const;

type PhoneReason = (typeof PHONE_REASONS)[number];

const isPhoneReason = (value: string): value is PhoneReason =>
  (PHONE_REASONS as readonly string[]).includes(value);

/**
 * Why a run stopped, in words.
 *
 * @param m - The sender's messages.
 * @param code - `stop_reason` as stored.
 * @returns The message, or the code itself when it is not one this release
 *   writes.
 */
export const describeStopReason = (
  m: AdminWhatsappMessages,
  code: string,
): string => {
  const named = STOP_REASONS[code];

  if (named) return named(m);

  const fatal = /^FATAL_(.+)$/.exec(code);

  return fatal?.[1] ? m.runReasonFatal({ code: fatal[1] }) : code;
};

/**
 * What a failure row is called in the run's breakdown.
 *
 * @param m - The sender's messages.
 * @param title - `error_title` as stored.
 * @returns The message for a code this release writes, or Meta's title as it
 *   arrived.
 */
export const describeFailure = (
  m: AdminWhatsappMessages,
  title: string,
): string => {
  const named = FAILURE_TITLES[title];

  if (named) return named(m);

  const meta = /^META_(\d+)$/.exec(title);

  if (meta?.[1]) return m.failureMeta({ code: meta[1] });

  const phone = /^INVALID_PHONE_([A-Z]+)$/.exec(title)?.[1]?.toLowerCase();

  return phone && isPhoneReason(phone)
    ? m.failureInvalidPhone({ reason: phone })
    : title;
};
