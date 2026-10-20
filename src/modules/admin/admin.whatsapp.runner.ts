import pkg from 'pg';

import {
  claimNext,
  countSendStatuses,
  findRunningRun,
  finishRun,
  settleSend,
  skipAlreadySent,
  sweepOnBoot,
} from './admin.whatsapp.repository.ts';

import { env } from '../../config/env.ts';
import {
  WHATSAPP_TEMPLATES,
  isWhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';
import { logger } from '../../shared/logger/logger.ts';
import { sendAlert } from '../../shared/telemetry/alerts.ts';
import { count } from '../../shared/telemetry/counters.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import { sendTemplate } from '../whatsapp/whatsapp.client.ts';

import type { ClaimedSend, RunningRun } from './admin.whatsapp.repository.ts';
import type { SendOutcome } from '../whatsapp/whatsapp.client.ts';

const { DatabaseError } = pkg;

/**
 * Drains a WhatsApp run, one message per tick.
 *
 * Modelled on `startEventSink` in `shared/telemetry/events.ts`: a module-scoped
 * timer and a start function returning its stop. No queue library.
 *
 * **Pacing is the interval.** Each tick sends at most one message, so the rate
 * is `WHATSAPP_SEND_INTERVAL_MS` and nothing sleeps — which is what makes a stop
 * immediate rather than the end of a sleep.
 *
 * **Shutdown does not drain and does not wait for the call in flight.** An
 * in-flight message has either been accepted by Meta or it has not, and holding
 * shutdown inside Docker's grace period cannot change which. The row stays
 * `sending`, the next boot's sweep marks it `interrupted`, and a person decides
 * what to do about it. The same reasoning as `alerts.ts` declining to retry: the
 * recovery is somewhere other than here.
 *
 * **Nothing here logs a phone number.** The client masks the one it logs; this
 * file logs run and row ids, codes and classifications.
 */

/** Permanent failures in a row that stop a run. Consecutive, not cumulative. */
const BREAKER_THRESHOLD = 10;

/** Longest `error_detail` stored. Meta's free text is for reading, not keeping. */
const DETAIL_MAX_LENGTH = 500;

/** The index a second `sent` row for the same attendee and template violates. */
const DELIVERED_ONCE_CONSTRAINT = 'whatsapp_sends_delivered_once';

let timer: NodeJS.Timeout | null = null;

/** Guards a slow Graph call against the next tick, like `flushing` in `events.ts`. */
let ticking = false;

/**
 * Consecutive permanent failures, and the run they belong to.
 *
 * In memory, so a restart resets it. That is acceptable because a restart also
 * pauses the run, and resuming is a deliberate act.
 */
const breaker = { runId: null as string | null, consecutive: 0 };

/**
 * Whether an error is the no-double-send index and not some other failure.
 *
 * @param err - Whatever the repository threw.
 */
const isDeliveredOnceViolation = (err: unknown): boolean =>
  err instanceof DatabaseError &&
  err.code === '23505' &&
  err.constraint === DELIVERED_ONCE_CONSTRAINT;

/**
 * Stops a run for a reason the operator must hear about.
 *
 * Counted rather than stored in `app_events`: `recordEvent` stores no `domain`
 * event, for the reason `record.ts` gives, and `whatsapp_runs.stop_reason` is
 * this failure's durable home.
 *
 * @param run - Run to stop.
 * @param reason - `stop_reason` to write.
 * @param means - What the alert tells the operator it means.
 */
const failRun = async (
  run: RunningRun,
  reason: string,
  means: string,
): Promise<void> => {
  // Already moved by an operator in the same second: leave it as they left it.
  if (!(await finishRun(run.run_id, 'failed', reason))) return;

  logger.error(
    { runId: run.run_id, templateKey: run.template_key, reason },
    'WhatsApp run stopped',
  );

  recordEvent({
    severity: 'error',
    kind: 'domain',
    code: 'WHATSAPP_RUN_FAILED',
    message: `WhatsApp run stopped: ${reason}`,
    fields: { runId: run.run_id, templateKey: run.template_key, reason },
  });

  sendAlert({
    severity: 'error',
    title: `WhatsApp run stopped (${reason})`,
    fingerprint: `whatsapp:run:${run.run_id}:failed`,
    means,
    check:
      'The Mensagens screen groups the failures by error. Rows not yet attempted are still pending; a new preview picks them up.',
    fields: { runId: run.run_id, templateKey: run.template_key, reason },
  });
};

/**
 * Finishes a run once nothing in it can be claimed.
 *
 * Rows still inside their back-off are `pending` and simply wait. A run left
 * with `interrupted` rows is paused instead of finished, so re-sending them
 * stays a decision somebody makes.
 *
 * @param run - Run that had nothing claimable this tick.
 */
const finishIfDrained = async (run: RunningRun): Promise<void> => {
  const counts = await countSendStatuses(run.run_id);

  if (counts.pending > 0 || counts.sending > 0) return;

  const fields = {
    runId: run.run_id,
    templateKey: run.template_key,
    sent: counts.sent,
    failed: counts.failed,
    skipped: counts.skipped,
    deferred: counts.deferred,
    interrupted: counts.interrupted,
  };

  if (counts.interrupted > 0) {
    if (!(await finishRun(run.run_id, 'paused', 'AWAITING_INTERRUPTED'))) {
      return;
    }

    logger.warn(fields, 'WhatsApp run paused with interrupted sends');

    sendAlert({
      severity: 'warn',
      title: 'WhatsApp run paused — interrupted sends need a decision',
      fingerprint: `whatsapp:run:${run.run_id}:awaiting-interrupted`,
      means:
        'Everything else is settled. The interrupted rows may or may not have reached the recipient, so they are not re-sent automatically.',
      check:
        'Mensagens: "Reenviar interrompidos" then "Retomar", or "Cancelar envio" to leave them.',
      fields,
    });

    return;
  }

  if (!(await finishRun(run.run_id, 'done', null))) return;

  logger.info(fields, 'WhatsApp run completed');

  sendAlert({
    severity: 'warn',
    title: 'WhatsApp run completed',
    fingerprint: `whatsapp:run:${run.run_id}:done`,
    means:
      'Every recipient has been attempted. "Sent" means Meta accepted the message, not that it was delivered.',
    check: 'The Mensagens screen, for the failures and the delivery figures.',
    fields,
  });
};

/**
 * Writes what one attempt came to, and stops the run if it has to.
 *
 * @param run - Run being drained.
 * @param claimed - Row that was attempted.
 * @param outcome - What the client reported.
 */
const settle = async (
  run: RunningRun,
  claimed: ClaimedSend,
  outcome: SendOutcome,
): Promise<void> => {
  if (outcome.ok) {
    breaker.consecutive = 0;

    const sent = {
      wamid: outcome.wamid,
      waId: outcome.waId,
      messageStatus: outcome.messageStatus,
      errorCode: null,
      errorDetail: null,
    };

    try {
      await settleSend(claimed.send_id, {
        ...sent,
        status: 'sent',
        errorTitle: null,
      });

      count('whatsapp.sent');
    } catch (err) {
      if (!isDeliveredOnceViolation(err)) throw err;

      // The claim's guard makes this unreachable while one run is active at a
      // time. If it is reached, the message has already gone out: this records
      // that, it does not undo it.
      await settleSend(claimed.send_id, {
        ...sent,
        status: 'skipped',
        errorTitle: 'ALREADY_SENT',
      });

      count('whatsapp.skipped');

      logger.error(
        { runId: run.run_id, sendId: claimed.send_id },
        'WhatsApp template sent to an attendee who already had it',
      );
    }

    return;
  }

  const failure = {
    wamid: null,
    waId: null,
    messageStatus: null,
    errorCode: outcome.code,
    errorTitle:
      outcome.code === null ? 'NO_RESPONSE' : `META_${String(outcome.code)}`,
    errorDetail: outcome.detail?.slice(0, DETAIL_MAX_LENGTH) ?? null,
  };

  switch (outcome.classification) {
    case 'transient': {
      if (claimed.attempts < env.whatsapp.maxAttempts) {
        await settleSend(claimed.send_id, { ...failure, status: 'pending' });
        count('whatsapp.retried');

        return;
      }

      await settleSend(claimed.send_id, {
        ...failure,
        status: 'failed',
        errorTitle: 'NO_RESPONSE',
      });
      count('whatsapp.failed');

      return;
    }

    case 'deferred': {
      await settleSend(claimed.send_id, { ...failure, status: 'deferred' });
      count('whatsapp.deferred');

      return;
    }

    case 'permanent': {
      await settleSend(claimed.send_id, { ...failure, status: 'failed' });
      count('whatsapp.failed');

      breaker.consecutive += 1;

      if (breaker.consecutive >= BREAKER_THRESHOLD) {
        await failRun(
          run,
          'CIRCUIT_BREAKER',
          `${String(BREAKER_THRESHOLD)} recipients in a row were refused. A roster carries a scatter of these; a run of them usually means the template or the numbers are wrong, not the recipients.`,
        );
      }

      return;
    }

    case 'fatal': {
      await settleSend(claimed.send_id, { ...failure, status: 'failed' });
      count('whatsapp.failed');

      await failRun(
        run,
        `FATAL_${String(outcome.code ?? 'UNKNOWN')}`,
        'Meta refused in a way that will fail every remaining message — an expired token, a template mismatch, or an account restriction.',
      );

      return;
    }
  }
};

/** One tick: at most one message. */
const step = async (): Promise<void> => {
  const run = await findRunningRun();

  if (!run) return;

  if (breaker.runId !== run.run_id) {
    breaker.runId = run.run_id;
    breaker.consecutive = 0;
  }

  if (!isWhatsappTemplateKey(run.template_key)) {
    await failRun(
      run,
      'UNKNOWN_TEMPLATE',
      'The run names a template this release no longer knows. Nothing was sent for it.',
    );

    return;
  }

  await skipAlreadySent(run.run_id);

  const claimed = await claimNext(run.run_id);

  if (!claimed) {
    await finishIfDrained(run);

    return;
  }

  try {
    const outcome = await sendTemplate(
      WHATSAPP_TEMPLATES[run.template_key],
      claimed.to_e164,
      claimed,
    );

    await settle(run, claimed, outcome);
  } catch (err) {
    // The row is held as `sending`, and a throw here — most likely a database
    // error while settling — means nothing will settle it. Left alone, the run
    // would wait on it for ever. The message may already have gone out, so it
    // gets the boot sweep's answer rather than a retry or a failure. A no-op if
    // the row was settled before the throw.
    await settleSend(claimed.send_id, {
      status: 'interrupted',
      wamid: null,
      waId: null,
      messageStatus: null,
      errorCode: null,
      errorTitle: 'INTERRUPTED',
      errorDetail: null,
    }).catch((markErr: unknown) => {
      logger.error(
        { err: markErr, runId: run.run_id, sendId: claimed.send_id },
        'Could not mark a WhatsApp send interrupted',
      );
    });

    throw err;
  }
};

/** Runs one step unless the previous one is still in flight. */
const tick = async (): Promise<void> => {
  if (ticking) return;

  ticking = true;

  try {
    await step();
  } finally {
    ticking = false;
  }
};

/**
 * Sweeps what a previous process left behind, then starts the send loop.
 *
 * Async so the caller can await the sweep: a tick that ran before it could claim
 * from a run the sweep was about to pause.
 *
 * @returns A function that stops the loop, for the shutdown path.
 */
export const startWhatsappRunner = async (): Promise<() => void> => {
  if (timer) return () => undefined;

  const swept = await sweepOnBoot();

  if (swept.interrupted > 0 || swept.paused > 0) {
    logger.warn(swept, 'WhatsApp runs paused by restart');

    sendAlert({
      severity: 'warn',
      title: 'WhatsApp run paused by a restart',
      fingerprint: `whatsapp:restart:${String(Date.now())}`,
      means:
        'The process restarted during a run. Nothing is sent until somebody resumes it, and a message that was mid-call is marked interrupted rather than re-sent.',
      check: 'Mensagens: decide on the interrupted rows, then "Retomar".',
      fields: swept,
    });
  }

  timer = setInterval(() => {
    // Wrapped whole, as `startAlertRules` is: a tick that throws must not end
    // the interval and look exactly like a run with nothing left to send.
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'WhatsApp runner tick failed');
    });
  }, env.whatsapp.sendIntervalMs);

  timer.unref();

  logger.info(
    {
      intervalMs: env.whatsapp.sendIntervalMs,
      maxAttempts: env.whatsapp.maxAttempts,
    },
    'WhatsApp runner started',
  );

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
};
