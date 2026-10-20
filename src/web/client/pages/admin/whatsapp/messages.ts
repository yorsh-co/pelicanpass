import { createAdminWhatsappMessages } from '../../../../../i18n/generated/admin-whatsapp.messages.ts';
import {
  describeFailure,
  describeStopReason,
} from '../../../../../modules/whatsapp/whatsapp.run-codes.ts';
import { readMessages } from '../../../core/i18n.ts';

import type {
  RunPreview,
  RunSummary,
} from '../../../core/api/api.admin.whatsapp.ts';

const whatsapp = readMessages('admin-whatsapp', createAdminWhatsappMessages);

/**
 * What the sender's script writes, read from the `admin-whatsapp` catalog the
 * route inlined. Static text is rendered by `whatsapp/index.ejs`.
 */
export const SENDER_COPY = {
  /** The run's status, with the server's stop reason when there is one. */
  status: (run: RunSummary): string => {
    const status = whatsapp.runStatus({ status: run.status });

    return run.stopReason
      ? whatsapp.runStatusWithReason({
          status,
          reason: describeStopReason(whatsapp, run.stopReason),
        })
      : status;
  },

  /** What a failure row is called: a named code, or Meta's own title. */
  failure: (title: string): string => describeFailure(whatsapp, title),

  /** The one-line summary of a preview. */
  previewCounts: (preview: RunPreview): string =>
    whatsapp.previewCounts({
      newRecipients: preview.newRecipients,
      alreadySent: preview.alreadySent,
      invalidPhone: preview.invalidPhone,
    }),

  /** What a preview's new recipients would cost at most. */
  previewCost: (preview: RunPreview): string =>
    whatsapp.previewCost({ cost: preview.estimatedCostUsd }),

  /** Under a preview list that shows fewer rows than it counts. */
  previewMore: (shown: number, total: number): string =>
    whatsapp.previewMore({ shown, total }),

  /** The start button's label once a preview exists. */
  confirmTo: (template: string, count: number): string =>
    whatsapp.previewConfirmTo({ template, count }),

  /** A test send Meta refused, with its error code when it gave one. */
  testRefused: (title: string, code: number | null): string =>
    code === null
      ? whatsapp.testRefused({ title })
      : whatsapp.testRefusedWithCode({ title, code: String(code) }),

  /** A test send Meta accepted after rewriting the number to `waId`. */
  testSentNormalized: (waId: string): string =>
    whatsapp.testSentNormalized({ waId }),

  /** What the run's delivered messages have cost so far. */
  runSpent: (cost: number): string => whatsapp.runSpent({ cost }),

  /** How many interrupted sends went back on the queue. */
  requeued: (count: number): string =>
    count === 0 ? whatsapp.runNoneRequeued() : whatsapp.runRequeued({ count }),

  testSentUnchanged: whatsapp.testSentUnchanged(),
  failed: whatsapp.runFailed(),
  forbidden: whatsapp.runForbidden(),
  previewFailed: whatsapp.previewFailed(),
  startFailed: whatsapp.runStartFailed(),
  testFailed: whatsapp.testFailed(),
  started: whatsapp.runStarted(),
  done: whatsapp.runDone(),
  stopped: whatsapp.runStopped(),
} as const;
