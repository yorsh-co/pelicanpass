import { randomUUID } from 'node:crypto';

import pkg from 'pg';

import {
  countDeliveries,
  countSendStatuses,
  getCurrentRun,
  getRun,
  insertRun,
  insertSends,
  listCandidates,
  listFailureGroups,
  requeueInterrupted,
  transitionRun,
  withTransaction,
} from './admin.whatsapp.repository.ts';

import { env } from '../../config/env.ts';
import {
  TEMPLATE_PRICE_USD,
  WHATSAPP_TEMPLATES,
  isWhatsappTemplateKey,
  type WhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';
import pg from '../../shared/db/postgres.ts';
import redis from '../../shared/db/redis.ts';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.ts';
import { sendAlert } from '../../shared/telemetry/alerts.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import { hash } from '../../shared/utils/hash.ts';
import { maskName, maskPhone } from '../../shared/utils/mask.ts';
import { isUuid } from '../../shared/utils/uuid.ts';
import { sendTemplate } from '../whatsapp/whatsapp.client.ts';
import { toE164 } from '../whatsapp/whatsapp.phone.ts';

import type { Request } from 'express';

import type { AdminRefusal } from '../../types/admin-refusal.ts';

import type {
  PlannedSend,
  RunStateRow,
  SendCandidateRow,
  SendStatusCounts,
} from './admin.whatsapp.repository.ts';
import type { TemplateAttendeeRow } from '../../constants/whatsapp-templates.ts';
import type { SendClassification } from '../whatsapp/whatsapp.errors.ts';
import type { AttendeeRole } from '../../types/attendee.ts';
import type { AdminSession } from '../../types/session.ts';

const { DatabaseError } = pkg;

/**
 * Previewing a WhatsApp run, starting it, and moving it between states.
 *
 * Refusals carry a `reason`, for the reason `admin.attendees.service.ts` gives:
 * `ConflictError` carries one code for several refusals.
 *
 * **Nothing here logs or returns a phone number, a name, a ticket code or an
 * entry link.** The preview is the one response that carries attendee data at
 * all, and it carries it masked and capped.
 */

/** How long a preview stays confirmable. */
const PREVIEW_TTL_SECONDS = 300;

/**
 * Most recipients a preview lists.
 *
 * The counts cover the whole segment; the list is a sample to recognise names
 * by, and seven hundred rows of attendee data is not something to push through
 * a response for that.
 */
const PREVIEW_SAMPLE_LIMIT = 50;

/** The constraint a second live run for the event violates. */
const ONE_ACTIVE_CONSTRAINT = 'whatsapp_runs_one_active';

/** Where a candidate lands when a run is confirmed. */
export type PreviewState = 'new' | 'already_sent' | 'invalid_phone';

/** One masked row of the preview sample. */
export interface PreviewRow {
  name: string;
  phone: string;
  state: PreviewState;
}

/** What a preview returns. */
export interface RunPreview {
  previewToken: string;
  newRecipients: number;
  alreadySent: number;
  invalidPhone: number;
  total: number;
  /** New recipients at the category's rate: an upper bound, since Meta bills on delivery. */
  estimatedCostUsd: number;
  rows: PreviewRow[];
}

/**
 * The attendee a test send stands in for.
 *
 * Placeholders rather than a real attendee, so a test aimed at a typed number
 * cannot carry anybody's working entry link. `teste-envio` is not the shape of a
 * ticket code, so it cannot name a real one, and the link it builds opens
 * nothing. Checking a link end to end is `scripts/whatsapp/send-test.ts`'s job.
 */
const TEST_SEND_ROW: TemplateAttendeeRow = {
  attendee_name: 'Teste',
  ticket_code: 'teste-envio',
  ticket_link_token: 'teste-envio',
  team: 'Equipe teste',
  checkin_time: '08:00:00',
  lunch_option: '11h',
};

/**
 * What a test send reports.
 *
 * A refusal from Meta is an answer rather than an error: the request worked,
 * and what Meta said is exactly what the operator pressed the button to find
 * out. `differs` is whether Meta canonicalised the number, which is the cheapest
 * check on the Brazilian ninth digit.
 */
export type TestSendResult =
  | { sent: true; wamid: string; waId: string; differs: boolean }
  | {
      sent: false;
      code: number | null;
      classification: SendClassification;
      title: string;
    };

/**
 * What the progress poll reports about one run.
 *
 * Counts only. A poll every three seconds has no business carrying a name or a
 * number.
 */
export interface CurrentRunSummary {
  runId: string;
  templateKey: string;
  role: string;
  status: RunStateRow['status'];
  stopReason: string | null;
  total: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  counts: SendStatusCounts & { delivered: number; read: number };
  /**
   * Delivered messages at the category's current rate, or `null` when the
   * run's template has left the registry and has no category to price.
   */
  spentUsd: number | null;
  failures: { errorTitle: string; count: number }[];
}

/**
 * What a preview token stands for, as held in Redis.
 *
 * `templateKey` and `role` are plain strings because the value is parsed back
 * out of Redis rather than narrowed, and is compared, never trusted.
 */
interface StoredPreview {
  adminId: string;
  templateKey: string;
  role: string;
  newRecipients: number;
  invalidPhone: number;
}

/** A candidate with its confirm-time outcome worked out. */
interface ClassifiedCandidate {
  row: SendCandidateRow;
  state: PreviewState;
  toE164: string | null;
  errorTitle: string | null;
}

/**
 * Builds the Redis key for a preview token.
 *
 * Hashed, as `reviewKey` in `staff.repository.ts` is: the token authorises a
 * send to hundreds of people, and the keyspace should not hold it usable.
 *
 * @param token - The opaque token given to the operator.
 */
const previewKey = (token: string): string => `whatsapp:preview:${hash(token)}`;

/**
 * Works out what confirming would do to each candidate.
 *
 * @param rows - Candidates from `listCandidates`.
 */
const classify = (rows: readonly SendCandidateRow[]): ClassifiedCandidate[] =>
  rows.map((row) => {
    if (row.already_sent) {
      return { row, state: 'already_sent', toE164: null, errorTitle: null };
    }

    const phone = toE164(row.attendee_phone, env.whatsapp.defaultCountryCode);

    if (!phone.ok) {
      return {
        row,
        state: 'invalid_phone',
        toE164: null,
        errorTitle: `INVALID_PHONE_${phone.reason.toUpperCase()}`,
      };
    }

    return { row, state: 'new', toE164: phone.e164, errorTitle: null };
  });

/**
 * Counts classified candidates by state.
 *
 * @param candidates - Output of {@link classify}.
 */
const countStates = (
  candidates: readonly ClassifiedCandidate[],
): Record<PreviewState, number> => {
  const counts: Record<PreviewState, number> = {
    new: 0,
    already_sent: 0,
    invalid_phone: 0,
  };

  for (const candidate of candidates) counts[candidate.state] += 1;

  return counts;
};

/**
 * Whether an error is a second live run and not some other failure.
 *
 * Matched by constraint name, the way `isTicketCodeCollision` is.
 *
 * @param err - Whatever the repository threw.
 */
const isActiveRunCollision = (err: unknown): boolean =>
  err instanceof DatabaseError &&
  err.code === '23505' &&
  err.constraint === ONE_ACTIVE_CONSTRAINT;

/** Operations behind `whatsapp:send`. */
export class AdminWhatsappService {
  readonly req: Request;

  /**
   * Takes the request alone, as `AdminAttendeesService` does.
   *
   * @param req - Request carrying an already-gated admin session.
   */
  constructor(req: Request) {
    this.req = req;
  }

  /** The administrator every action is recorded against. */
  get adminId(): string | undefined {
    const session = this.req.session as AdminSession | undefined;

    return session?.adminId ?? undefined;
  }

  /**
   * Counts who a run would reach, and issues the token that confirms it.
   *
   * @param templateKey - Template to send; already narrowed by the caller.
   * @param role - Audience; already narrowed by the caller.
   * @returns Three counts, a masked sample and the preview token.
   * @throws {ValidationError} If the template may not be sent to that role.
   */
  async preview(
    templateKey: WhatsappTemplateKey,
    role: AttendeeRole,
  ): Promise<RunPreview> {
    this.#assertRoleAllowed(templateKey, role);

    const candidates = classify(await listCandidates(pg, role, templateKey));
    const counts = countStates(candidates);

    const previewToken = randomUUID();

    const stored: StoredPreview = {
      adminId: this.#requireAdminId(),
      templateKey,
      role,
      newRecipients: counts.new,
      invalidPhone: counts.invalid_phone,
    };

    await redis.set(
      previewKey(previewToken),
      JSON.stringify(stored),
      'EX',
      PREVIEW_TTL_SECONDS,
    );

    return {
      previewToken,
      newRecipients: counts.new,
      alreadySent: counts.already_sent,
      invalidPhone: counts.invalid_phone,
      total: candidates.length,
      estimatedCostUsd:
        counts.new *
        TEMPLATE_PRICE_USD[WHATSAPP_TEMPLATES[templateKey].category],
      rows: candidates.slice(0, PREVIEW_SAMPLE_LIMIT).map((candidate) => ({
        name: maskName(candidate.row.attendee_name),
        phone: maskPhone(candidate.row.attendee_phone),
        state: candidate.state,
      })),
    };
  }

  /**
   * Starts the run a preview described.
   *
   * The token is consumed first, so a double-tapped confirm cannot start two
   * runs even before the database constraint is reached. The segment is then
   * re-counted inside the transaction: if either count moved, the operator is
   * refused rather than sent against a list they never saw.
   *
   * Recipients whose phone will not normalise are written as `skipped` rather
   * than left out, so the run can account for everybody it declined to
   * contact. Attendees this template already reached get no row at all.
   *
   * @param templateKey - Template to send; already narrowed by the caller.
   * @param role - Audience; already narrowed by the caller.
   * @param previewToken - Token from {@link preview}.
   * @returns The new run's ID and how many rows it holds.
   * @throws {ValidationError} If the template may not be sent to that role.
   * @throws {ConflictError} If the preview expired or does not match, the
   *   segment changed, or a run is already active.
   */
  async startRun(
    templateKey: WhatsappTemplateKey,
    role: AttendeeRole,
    previewToken: string,
  ): Promise<{ runId: string; total: number }> {
    this.#assertEnabled();
    this.#assertRoleAllowed(templateKey, role);

    const adminId = this.#requireAdminId();
    const raw = await redis.getdel(previewKey(previewToken));
    const stored = raw === null ? null : (JSON.parse(raw) as StoredPreview);

    if (
      stored?.adminId !== adminId ||
      stored.templateKey !== templateKey ||
      stored.role !== role
    ) {
      throw new ConflictError('Preview expired', {
        reason: 'previewExpired',
      });
    }

    try {
      const result = await withTransaction(async (client) => {
        const candidates = classify(
          await listCandidates(client, role, templateKey),
        );
        const counts = countStates(candidates);

        if (
          counts.new !== stored.newRecipients ||
          counts.invalid_phone !== stored.invalidPhone
        ) {
          throw new ConflictError('Recipient list changed', {
            reason: 'listChanged',
          });
        }

        const planned: PlannedSend[] = candidates
          .filter((candidate) => candidate.state !== 'already_sent')
          .map((candidate) => ({
            attendeeId: candidate.row.attendee_id,
            status: candidate.state === 'new' ? 'pending' : 'skipped',
            toE164: candidate.toE164,
            errorTitle: candidate.errorTitle,
          }));

        const runId = await insertRun(client, {
          templateKey,
          role,
          startedBy: adminId,
          total: planned.length,
        });

        await insertSends(client, runId, templateKey, planned);

        return { runId, total: planned.length };
      });

      this.req.log.info(
        {
          adminId,
          runId: result.runId,
          templateKey,
          role,
          total: result.total,
        },
        'WhatsApp run started',
      );

      const fields = {
        runId: result.runId,
        templateKey,
        role,
        total: result.total,
      };

      recordEvent({
        severity: 'info',
        kind: 'domain',
        code: 'WHATSAPP_RUN_STARTED',
        message: 'WhatsApp run started',
        actorType: 'admin',
        actorId: adminId,
        fields,
      });

      sendAlert({
        severity: 'warn',
        title: 'WhatsApp run started',
        fingerprint: `whatsapp:run:${result.runId}:started`,
        means: `Messages are going out at one every ${String(env.whatsapp.sendIntervalMs)} ms. Nobody needs to watch the screen; the next message here is the end of the run.`,
        check:
          'Nothing, unless it was not expected — then "Parar" on the Mensagens screen.',
        fields,
      });

      return result;
    } catch (err) {
      if (isActiveRunCollision(err)) {
        throw new ConflictError('A run is already in progress', {
          reason: 'runInProgress',
        });
      }

      throw err;
    }
  }

  /**
   * Pauses a running run at the operator's request.
   *
   * @param runId - Run to stop, as received.
   * @returns The run's new status.
   * @throws {NotFoundError} If no run has that ID under this event.
   * @throws {ConflictError} If the run is not running.
   */
  async stopRun(runId: string): Promise<{ status: RunStateRow['status'] }> {
    return this.#transition(
      runId,
      ['running'],
      'paused',
      'OPERATOR',
      'runNotRunning',
    );
  }

  /**
   * Resumes a paused run.
   *
   * @param runId - Run to resume, as received.
   * @returns The run's new status.
   * @throws {NotFoundError} If no run has that ID under this event.
   * @throws {ConflictError} If the run is not paused.
   */
  async resumeRun(runId: string): Promise<{ status: RunStateRow['status'] }> {
    this.#assertEnabled();

    return this.#transition(runId, ['paused'], 'running', null, 'runNotPaused');
  }

  /**
   * Re-queues the rows a restart left `interrupted`.
   *
   * Paused runs only. A restart pauses every running run, so that is the state
   * an interrupted row is found in, and re-queuing into a run the operator has
   * not yet chosen to resume keeps the "Reenviar" and "Retomar" decisions
   * separate.
   *
   * @param runId - Run whose rows to re-queue, as received.
   * @returns How many rows went back to `pending`.
   * @throws {NotFoundError} If no run has that ID under this event.
   * @throws {ConflictError} If the run is not paused.
   */
  async retryInterrupted(runId: string): Promise<{ queued: number }> {
    const run = await this.#loadRun(runId);

    if (run.status !== 'paused') {
      throw new ConflictError('Pause the run before retrying', {
        reason: 'pauseBeforeRetry',
      });
    }

    const queued = await requeueInterrupted(run.run_id);

    this.req.log.info(
      { adminId: this.adminId, runId: run.run_id, queued },
      'WhatsApp interrupted sends re-queued',
    );

    return { queued };
  }

  /**
   * Abandons a run, so it stops counting as the event's active one.
   *
   * A paused run is still active, and without this a run nobody means to resume
   * would block every later run for the event.
   *
   * Rows not yet attempted stay `pending`. They were never sent, so a later
   * preview counts those attendees as new and a later run reaches them.
   *
   * @param runId - Run to cancel, as received.
   * @returns The run's new status.
   * @throws {NotFoundError} If no run has that ID under this event.
   * @throws {ConflictError} If the run has already finished.
   */
  async cancelRun(runId: string): Promise<{ status: RunStateRow['status'] }> {
    return this.#transition(
      runId,
      ['running', 'paused'],
      'failed',
      'OPERATOR_CANCELLED',
      'runFinished',
    );
  }

  /**
   * Sends one template to a typed number, outside any run.
   *
   * Writes no `whatsapp_sends` row: it is not part of any run's record, and a
   * row would count a test toward the no-double-send index.
   *
   * @param templateKey - Template to send; already narrowed by the caller.
   * @param phone - Number as typed.
   * @returns What Meta said.
   * @throws {ConflictError} If sending is disabled on this server.
   * @throws {ValidationError} If the number will not normalise.
   */
  async testSend(
    templateKey: WhatsappTemplateKey,
    phone: string,
  ): Promise<TestSendResult> {
    this.#assertEnabled();

    const to = toE164(phone, env.whatsapp.defaultCountryCode);

    if (!to.ok) {
      throw new ValidationError('Invalid test phone', {
        reason: 'testPhoneInvalid',
      });
    }

    const outcome = await sendTemplate(
      WHATSAPP_TEMPLATES[templateKey],
      to.e164,
      TEST_SEND_ROW,
    );

    // The client has already logged the masked number; this names who asked.
    this.req.log.info(
      {
        adminId: this.adminId,
        templateKey,
        sent: outcome.ok,
        code: outcome.ok ? null : outcome.code,
      },
      'WhatsApp test send',
    );

    if (outcome.ok) {
      return {
        sent: true,
        wamid: outcome.wamid,
        waId: outcome.waId,
        differs: outcome.waId !== to.e164,
      };
    }

    return {
      sent: false,
      code: outcome.code,
      classification: outcome.classification,
      title: outcome.title,
    };
  }

  /**
   * The run the sender screen should show: the active one, or else the latest.
   *
   * @returns The run's header and counts, or `null` if the event has none.
   */
  async currentRun(): Promise<CurrentRunSummary | null> {
    const run = await getCurrentRun();

    if (!run) return null;

    const [counts, deliveries, failures] = await Promise.all([
      countSendStatuses(run.run_id),
      countDeliveries(run.run_id),
      listFailureGroups(run.run_id),
    ]);

    return {
      runId: run.run_id,
      templateKey: run.template_key,
      role: run.target_role,
      status: run.status,
      stopReason: run.stop_reason,
      total: run.total_recipients,
      createdAt: run.created_at,
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      counts: { ...counts, ...deliveries },
      spentUsd: isWhatsappTemplateKey(run.template_key)
        ? deliveries.delivered *
          TEMPLATE_PRICE_USD[WHATSAPP_TEMPLATES[run.template_key].category]
        : null,
      failures,
    };
  }

  /**
   * Refuses an action that would send, on a server that cannot.
   *
   * Without it a run started here would sit `running` with no runner to drain
   * it, and the stall rule is gated on the same switch, so nothing would say so.
   *
   * @throws {ConflictError} If `WHATSAPP_ENABLED` is false.
   */
  #assertEnabled(): void {
    if (!env.whatsapp.enabled) {
      throw new ConflictError('WhatsApp sending is disabled', {
        reason: 'sendingDisabled',
      });
    }
  }

  /**
   * Refuses a role the template is not meant for.
   *
   * @param templateKey - Template being sent.
   * @param role - Audience chosen.
   * @throws {ValidationError} If the template does not list the role.
   */
  #assertRoleAllowed(
    templateKey: WhatsappTemplateKey,
    role: AttendeeRole,
  ): void {
    const roles: readonly AttendeeRole[] =
      WHATSAPP_TEMPLATES[templateKey].roles;

    if (!roles.includes(role)) {
      throw new ValidationError('Template not allowed for this audience', {
        reason: 'templateAudienceMismatch',
      });
    }
  }

  /**
   * The acting administrator's ID, which a run cannot be started without.
   *
   * @throws {Error} If the session carries none. The route gate makes that
   *   impossible, so it is a 500 rather than a refusal.
   */
  #requireAdminId(): string {
    const adminId = this.adminId;

    if (!adminId) throw new Error('Admin session carries no adminId');

    return adminId;
  }

  /**
   * Loads a run by an unchecked ID.
   *
   * @param runId - Value as received.
   * @throws {NotFoundError} If it is malformed or no run has that ID.
   */
  async #loadRun(runId: string): Promise<RunStateRow> {
    const run = isUuid(runId) ? await getRun(runId) : null;

    if (!run) {
      throw new NotFoundError('Run not found', { reason: 'runNotFound' });
    }

    return run;
  }

  /**
   * Moves a run between states, telling a missing run from a wrong state.
   *
   * @param runId - Value as received.
   * @param from - States the move is allowed from.
   * @param to - State to move to.
   * @param stopReason - Written to `stop_reason`.
   * @param refusal - Reason given when the run is in another state.
   * @throws {NotFoundError} If no run has that ID under this event.
   * @throws {ConflictError} If the run is not in a `from` state.
   */
  async #transition(
    runId: string,
    from: readonly RunStateRow['status'][],
    to: RunStateRow['status'],
    stopReason: string | null,
    refusal: AdminRefusal,
  ): Promise<{ status: RunStateRow['status'] }> {
    const run = await this.#loadRun(runId);
    const moved = await transitionRun(run.run_id, from, to, stopReason);

    if (!moved) {
      throw new ConflictError(`Run cannot move to ${to}`, { reason: refusal });
    }

    this.req.log.info(
      { adminId: this.adminId, runId: run.run_id, status: moved.status },
      'WhatsApp run status changed',
    );

    return { status: moved.status };
  }
}
