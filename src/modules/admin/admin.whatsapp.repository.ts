import { env } from '../../config/env.ts';
import { WHATSAPP_TEMPLATES } from '../../constants/whatsapp-templates.ts';
import pg from '../../shared/db/postgres.ts';

import type { Pool, PoolClient } from 'pg';

import type { WhatsappTemplateKey } from '../../constants/whatsapp-templates.ts';
import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * The record of WhatsApp runs and the sends inside them.
 *
 * Nothing here validates. The service owns the rules and this writes what it is
 * given, the arrangement `admin.attendees.repository.ts` describes.
 *
 * Every statement is scoped to `env.eventId`, for the reason
 * `attendee.repository.ts` gives: one stack serves one event.
 */

/** Anything a statement can run on: the pool, or a client inside a transaction. */
export type Queryable = Pool | PoolClient;

/** One attendee a template could be sent to. */
export interface SendCandidateRow {
  attendee_id: string;
  attendee_name: string;
  attendee_phone: string;

  /** Whether an earlier run already has this template `sent` to them. */
  already_sent: boolean;
}

/** One row {@link insertSends} writes. */
export interface PlannedSend {
  attendeeId: string;
  status: 'pending' | 'skipped';

  /** Set when `pending`; null when `skipped`. */
  toE164: string | null;

  /** Set when `skipped`; null when `pending`. */
  errorTitle: string | null;
}

/** What a state change needs to know about a run. */
export interface RunStateRow {
  run_id: string;
  status: 'running' | 'paused' | 'done' | 'failed';
}

/**
 * Runs `fn` inside one transaction on one pooled client.
 *
 * The sequence `completeCheckin` in `attendee.repository.ts` spells out inline,
 * lifted into a helper because starting a run spans three statements that must
 * land together or not at all.
 *
 * @param fn - Work to run; receives the client every statement must use.
 * @returns Whatever `fn` returns, after `COMMIT`.
 * @throws Whatever `fn` throws, after `ROLLBACK`.
 */
export const withTransaction = async <T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pg.connect();

  try {
    await client.query('BEGIN');

    const result = await fn(client);

    await client.query('COMMIT');

    return result;
  } catch (err) {
    await client.query('ROLLBACK');

    throw err;
  } finally {
    client.release();
  }
};

/**
 * Every active attendee of one role, and whether this template already reached
 * them.
 *
 * **The single definition of a run's segment.** The preview counts from it and
 * the confirm re-counts from it inside the transaction, so the two cannot
 * disagree about who is in scope.
 *
 * `already_sent` is the re-run exclusion, and it has to be a predicate here.
 * `whatsapp_sends_delivered_once` is partial on `status = 'sent'`, and enqueued
 * rows are born `pending`, so an `ON CONFLICT` against it would never fire. That
 * index remains the backstop at the moment a row becomes `sent`.
 *
 * A template marked `checkedInOnly` narrows the segment to completed check-ins.
 *
 * Ordered by name so the capped preview sample is stable between two presses.
 *
 * @param db - Pool or transaction client.
 * @param role - Audience to select.
 * @param templateKey - Template whose earlier sends exclude an attendee.
 */
export const listCandidates = async (
  db: Queryable,
  role: AttendeeRole,
  templateKey: WhatsappTemplateKey,
): Promise<SendCandidateRow[]> => {
  const result = await db.query<SendCandidateRow>(
    `SELECT a.attendee_id,
      a.attendee_name,
      a.attendee_phone,
      EXISTS (
        SELECT 1
        FROM whatsapp_sends s
        WHERE s.event_id = a.event_id
          AND s.attendee_id = a.attendee_id
          AND s.template_key = $3
          AND s.status = 'sent'
      ) AS already_sent
    FROM attendees a
    WHERE a.event_id = $1
      AND a.archived_at IS NULL
      AND a.attendee_role = $2
      AND (NOT $4::boolean OR a.checkin_complete)
    ORDER BY a.attendee_name, a.attendee_id`,
    [
      env.eventId,
      role,
      templateKey,
      WHATSAPP_TEMPLATES[templateKey].checkedInOnly,
    ],
  );

  return result.rows;
};

/**
 * Creates a run in `running`.
 *
 * A `23505` on `whatsapp_runs_one_active` is raised, not handled; the service
 * maps it.
 *
 * @param db - Transaction client.
 * @param input - Values the service has already validated.
 * @returns The new run's ID.
 * @throws {Error} If the insert returned no row, which is asserted rather than
 *   assumed.
 */
export const insertRun = async (
  db: Queryable,
  input: {
    templateKey: string;
    role: AttendeeRole;
    startedBy: string;
    total: number;
  },
): Promise<string> => {
  const result = await db.query<{ run_id: string }>(
    `INSERT INTO whatsapp_runs (
      event_id,
      template_key,
      target_role,
      status,
      started_by,
      total_recipients
    )
    VALUES ($1, $2, $3, 'running', $4, $5)
    RETURNING run_id`,
    [env.eventId, input.templateKey, input.role, input.startedBy, input.total],
  );

  const created = result.rows[0];

  if (!created) throw new Error('Run insert returned no row');

  return created.run_id;
};

/**
 * Enqueues a run's recipients in one statement.
 *
 * `unnest` over parallel arrays rather than a loop of inserts or a built
 * `VALUES` list: one round trip and a fixed parameter count however long the
 * roster is. The phone normalisation happens before this, in the service,
 * because `toE164` is TypeScript and a second copy in SQL would drift.
 *
 * @param db - Transaction client.
 * @param runId - Run the rows belong to.
 * @param templateKey - Denormalised onto each row for the no-double-send index.
 * @param rows - One entry per recipient.
 * @returns How many rows were written.
 */
export const insertSends = async (
  db: Queryable,
  runId: string,
  templateKey: string,
  rows: readonly PlannedSend[],
): Promise<number> => {
  if (rows.length === 0) return 0;

  const result = await db.query(
    `INSERT INTO whatsapp_sends (
      run_id,
      event_id,
      attendee_id,
      template_key,
      status,
      to_e164,
      error_title
    )
    SELECT $1, $2, r.attendee_id, $3, r.status, r.to_e164, r.error_title
    FROM unnest($4::uuid[], $5::text[], $6::text[], $7::text[])
      AS r (attendee_id, status, to_e164, error_title)`,
    [
      runId,
      env.eventId,
      templateKey,
      rows.map((row) => row.attendeeId),
      rows.map((row) => row.status),
      rows.map((row) => row.toE164),
      rows.map((row) => row.errorTitle),
    ],
  );

  return result.rowCount ?? 0;
};

/**
 * One run's current state.
 *
 * @param runId - Run to load.
 * @returns The run, or `null` if no run has that ID under this event.
 */
export const getRun = async (runId: string): Promise<RunStateRow | null> => {
  const result = await pg.query<RunStateRow>(
    `SELECT run_id, status
    FROM whatsapp_runs
    WHERE run_id = $1
      AND event_id = $2`,
    [runId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Moves a run to `to`, but only from one of the `from` states.
 *
 * Conditional in the statement itself, so two operators pressing opposite
 * buttons cannot both succeed against a state that one of them already changed.
 *
 * @param runId - Run to move.
 * @param from - States the move is allowed from.
 * @param to - State to move to.
 * @param stopReason - Written to `stop_reason`; null clears it.
 * @returns The updated run, or `null` if it was missing or in another state.
 */
export const transitionRun = async (
  runId: string,
  from: readonly RunStateRow['status'][],
  to: RunStateRow['status'],
  stopReason: string | null,
): Promise<RunStateRow | null> => {
  const result = await pg.query<RunStateRow>(
    `UPDATE whatsapp_runs
      SET status = $1,
        stop_reason = $2
    WHERE run_id = $3
      AND event_id = $4
      AND status = ANY($5::text[])
    RETURNING run_id, status`,
    [to, stopReason, runId, env.eventId, from],
  );

  return result.rows[0] ?? null;
};

/**
 * Puts a run's interrupted rows back in the queue.
 *
 * `attempts` is left as it is: a re-queued row has already used one, and the
 * attempt ceiling should count it.
 *
 * @param runId - Run whose rows to re-queue.
 * @returns How many rows were re-queued.
 */
export const requeueInterrupted = async (runId: string): Promise<number> => {
  const result = await pg.query(
    `UPDATE whatsapp_sends
      SET status = 'pending',
        error_title = NULL
    WHERE run_id = $1
      AND event_id = $2
      AND status = 'interrupted'`,
    [runId, env.eventId],
  );

  return result.rowCount ?? 0;
};

/** The run the runner should be draining. */
export interface RunningRun {
  run_id: string;
  template_key: string;
}

/**
 * A send the runner has claimed, with the attendee columns its template reads.
 *
 * Structurally a `TemplateAttendeeRow`, so it goes to the client as it is.
 * `send_id` is a `bigserial` and arrives from `pg` as a string.
 */
export interface ClaimedSend {
  send_id: string;
  attendee_id: string;
  to_e164: string;
  attempts: number;
  attendee_name: string;
  ticket_code: string;
  ticket_link_token: string;
  team: string | null;
  checkin_time: string | null;
  lunch_option: string | null;
}

/** Row counts of one run, by send status. */
export type SendStatusCounts = Record<
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'deferred'
  | 'interrupted',
  number
>;

/** What one attempt settled a claimed row as. */
export interface SendSettlement {
  status:
    'sent' | 'failed' | 'deferred' | 'skipped' | 'pending' | 'interrupted';
  wamid: string | null;
  waId: string | null;
  messageStatus: string | null;
  errorCode: number | null;
  errorTitle: string | null;
  errorDetail: string | null;
}

/**
 * Makes a restart stop sending rather than resume.
 *
 * Rows left `sending` become `interrupted`: the process died between handing a
 * message to Meta and writing the wamid, and nothing local can tell which side
 * of that line it fell on. Runs left `running` become `paused`, so a crash loop
 * cannot become a send loop. Both are undone only by an operator.
 *
 * @returns How many rows and runs were swept.
 */
export const sweepOnBoot = async (): Promise<{
  interrupted: number;
  paused: number;
}> =>
  withTransaction(async (client) => {
    const sends = await client.query(
      `UPDATE whatsapp_sends
        SET status = 'interrupted',
          error_title = 'INTERRUPTED'
      WHERE event_id = $1
        AND status = 'sending'`,
      [env.eventId],
    );

    const runs = await client.query(
      `UPDATE whatsapp_runs
        SET status = 'paused',
          stop_reason = 'RESTART'
      WHERE event_id = $1
        AND status = 'running'`,
      [env.eventId],
    );

    return { interrupted: sends.rowCount ?? 0, paused: runs.rowCount ?? 0 };
  });

/**
 * The event's running run, if there is one.
 *
 * At most one row can match: `whatsapp_runs_one_active` forbids a second.
 */
export const findRunningRun = async (): Promise<RunningRun | null> => {
  const result = await pg.query<RunningRun>(
    `SELECT run_id, template_key
    FROM whatsapp_runs
    WHERE event_id = $1
      AND status = 'running'`,
    [env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Settles, as `skipped`, pending rows whose attendee already has this template.
 *
 * Without this, a row the claim's `NOT EXISTS` guard refuses would stay
 * `pending` for ever and the run could never finish.
 *
 * @param runId - Run to sweep.
 * @returns How many rows were skipped.
 */
export const skipAlreadySent = async (runId: string): Promise<number> => {
  const result = await pg.query(
    `UPDATE whatsapp_sends s
      SET status = 'skipped',
        error_title = 'ALREADY_SENT'
    WHERE s.run_id = $1
      AND s.event_id = $2
      AND s.status = 'pending'
      AND EXISTS (
        SELECT 1
        FROM whatsapp_sends p
        WHERE p.event_id = s.event_id
          AND p.attendee_id = s.attendee_id
          AND p.template_key = s.template_key
          AND p.status = 'sent'
      )`,
    [runId, env.eventId],
  );

  return result.rowCount ?? 0;
};

/**
 * Claims the next sendable row of a run, and marks it `sending`.
 *
 * **Written before the HTTP call**, and deliberately not in the same
 * transaction as it: a crash mid-call leaves a `sending` row for the boot sweep
 * rather than no trace at all.
 *
 * `FOR UPDATE SKIP LOCKED` means two processes — a container mid-restart
 * overlapping its replacement — can never claim the same row.
 *
 * A row a transient failure put back is not claimable until its back-off has
 * passed: one second after the first attempt, doubling, capped at sixty. The
 * back-off is read off `claimed_at` and `attempts` rather than held in memory,
 * so a restart does not reset it.
 *
 * The `NOT EXISTS` is **the guard that stops a double-send**.
 * `whatsapp_sends_delivered_once` is only reached when a row is written `sent`,
 * which is after Meta has accepted the message, so it can record a duplicate
 * but cannot prevent one.
 *
 * Stamps the run's `started_at` on its first claim.
 *
 * @param runId - Run to claim from.
 * @returns The claimed row, or `null` if nothing is claimable now.
 */
export const claimNext = async (runId: string): Promise<ClaimedSend | null> => {
  const result = await pg.query<ClaimedSend>(
    `WITH claimed AS (
      UPDATE whatsapp_sends
        SET status = 'sending',
          claimed_at = now(),
          attempts = attempts + 1
      WHERE send_id = (
        SELECT q.send_id
        FROM whatsapp_sends q
        WHERE q.run_id = $1
          AND q.event_id = $2
          AND q.status = 'pending'
          AND (
            q.attempts = 0
            OR q.claimed_at < now()
              - make_interval(secs => least(60, power(2, q.attempts - 1)))
          )
          AND NOT EXISTS (
            SELECT 1
            FROM whatsapp_sends p
            WHERE p.event_id = q.event_id
              AND p.attendee_id = q.attendee_id
              AND p.template_key = q.template_key
              AND p.status = 'sent'
          )
        ORDER BY q.send_id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING send_id, attendee_id, to_e164, attempts
    ),
    started AS (
      UPDATE whatsapp_runs
        SET started_at = now()
      WHERE run_id = $1
        AND started_at IS NULL
        AND EXISTS (SELECT 1 FROM claimed)
    )
    SELECT c.send_id,
      c.attendee_id,
      c.to_e164,
      c.attempts,
      a.attendee_name,
      a.ticket_code,
      a.ticket_link_token,
      a.team,
      a.checkin_time,
      a.lunch_option
    FROM claimed c
    JOIN attendees a
      ON a.attendee_id = c.attendee_id
      AND a.event_id = $2`,
    [runId, env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * Writes what one attempt came to, on a row this process holds as `sending`.
 *
 * `sent_at` is stamped whenever a wamid is written, which includes the
 * `ALREADY_SENT` backstop: that message did go out.
 *
 * A `23505` on `whatsapp_sends_delivered_once` is raised, not handled.
 *
 * @param sendId - Row to settle.
 * @param settlement - Its new status and what Meta said.
 */
export const settleSend = async (
  sendId: string,
  settlement: SendSettlement,
): Promise<void> => {
  await pg.query(
    `UPDATE whatsapp_sends
      SET status = $1,
        wamid = $2,
        wa_id = $3,
        message_status = $4,
        error_code = $5,
        error_title = $6,
        error_detail = $7,
        sent_at = CASE WHEN $2::text IS NULL THEN sent_at ELSE now() END
    WHERE send_id = $8
      AND event_id = $9
      AND status = 'sending'`,
    [
      settlement.status,
      settlement.wamid,
      settlement.waId,
      settlement.messageStatus,
      settlement.errorCode,
      settlement.errorTitle,
      settlement.errorDetail,
      sendId,
      env.eventId,
    ],
  );
};

/**
 * One run's rows, counted by status.
 *
 * @param runId - Run to count.
 */
export const countSendStatuses = async (
  runId: string,
): Promise<SendStatusCounts> => {
  const result = await pg.query<Record<keyof SendStatusCounts, string>>(
    `SELECT
      count(*) FILTER (WHERE status = 'pending') AS pending,
      count(*) FILTER (WHERE status = 'sending') AS sending,
      count(*) FILTER (WHERE status = 'sent') AS sent,
      count(*) FILTER (WHERE status = 'failed') AS failed,
      count(*) FILTER (WHERE status = 'skipped') AS skipped,
      count(*) FILTER (WHERE status = 'deferred') AS deferred,
      count(*) FILTER (WHERE status = 'interrupted') AS interrupted
    FROM whatsapp_sends
    WHERE run_id = $1
      AND event_id = $2`,
    [runId, env.eventId],
  );

  const row = result.rows[0];
  const read = (value: string | undefined): number =>
    Number.parseInt(value ?? '0', 10);

  return {
    pending: read(row?.pending),
    sending: read(row?.sending),
    sent: read(row?.sent),
    failed: read(row?.failed),
    skipped: read(row?.skipped),
    deferred: read(row?.deferred),
    interrupted: read(row?.interrupted),
  };
};

/**
 * Ends or pauses a running run from inside the runner.
 *
 * Conditional on `running`, so a run an operator stopped or cancelled in the
 * same second is left as they left it. `finished_at` is stamped only for a
 * terminal state.
 *
 * @param runId - Run to move.
 * @param to - `done`, `failed`, or `paused`.
 * @param stopReason - Written to `stop_reason`.
 * @returns Whether the run was still running and was moved.
 */
export const finishRun = async (
  runId: string,
  to: 'done' | 'failed' | 'paused',
  stopReason: string | null,
): Promise<boolean> => {
  const result = await pg.query(
    `UPDATE whatsapp_runs
      SET status = $1,
        stop_reason = $2,
        finished_at = CASE WHEN $1 = 'paused' THEN finished_at ELSE now() END
    WHERE run_id = $3
      AND event_id = $4
      AND status = 'running'`,
    [to, stopReason, runId, env.eventId],
  );

  return (result.rowCount ?? 0) > 0;
};

/**
 * A running run that has claimed nothing for `minutes`.
 *
 * Measured from the latest claim, falling back to when the run started and then
 * to when it was created, so a run that never claimed at all still counts.
 *
 * @param minutes - How long without a claim counts as stalled.
 * @returns The stalled run's ID, or `null`.
 */
export const findStalledRun = async (
  minutes: number,
): Promise<string | null> => {
  const result = await pg.query<{ run_id: string }>(
    `SELECT r.run_id
    FROM whatsapp_runs r
    WHERE r.event_id = $1
      AND r.status = 'running'
      AND coalesce(
        (SELECT max(s.claimed_at) FROM whatsapp_sends s WHERE s.run_id = r.run_id),
        r.started_at,
        r.created_at
      ) < now() - make_interval(mins => $2)`,
    [env.eventId, minutes],
  );

  return result.rows[0]?.run_id ?? null;
};

/** A run's header, as the progress poll shows it. */
export interface CurrentRunRow {
  run_id: string;
  template_key: string;
  target_role: string;
  status: RunStateRow['status'];
  stop_reason: string | null;
  total_recipients: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

/**
 * The active run, or else the most recent one.
 *
 * Falling back to the latest finished run is what lets the screen still show
 * how a run ended, and its delivery figures, which keep moving after it does.
 */
export const getCurrentRun = async (): Promise<CurrentRunRow | null> => {
  const result = await pg.query<CurrentRunRow>(
    `SELECT run_id,
      template_key,
      target_role,
      status,
      stop_reason,
      total_recipients,
      created_at,
      started_at,
      finished_at
    FROM whatsapp_runs
    WHERE event_id = $1
    ORDER BY (status IN ('running', 'paused')) DESC, created_at DESC
    LIMIT 1`,
    [env.eventId],
  );

  return result.rows[0] ?? null;
};

/**
 * How many of a run's messages Meta reported delivered, and read.
 *
 * `delivered` includes the read ones: a message cannot be read without having
 * arrived, and a receipt for `read` can land without a `delivered` before it.
 *
 * @param runId - Run to count.
 */
export const countDeliveries = async (
  runId: string,
): Promise<{ delivered: number; read: number }> => {
  const result = await pg.query<{ delivered: number; read: number }>(
    `SELECT
      count(*) FILTER (WHERE delivery_status IN ('delivered', 'read'))::int AS delivered,
      count(*) FILTER (WHERE delivery_status = 'read')::int AS read
    FROM whatsapp_sends
    WHERE run_id = $1
      AND event_id = $2`,
    [runId, env.eventId],
  );

  return result.rows[0] ?? { delivered: 0, read: 0 };
};

/**
 * A run's unsuccessful rows, grouped by the classification we assigned.
 *
 * Grouped on `error_title` rather than Meta's detail text, which is free prose
 * and would not group anything.
 *
 * @param runId - Run to group.
 */
export const listFailureGroups = async (
  runId: string,
): Promise<{ errorTitle: string; count: number }[]> => {
  const result = await pg.query<{ errorTitle: string; count: number }>(
    `SELECT coalesce(error_title, 'UNKNOWN') AS "errorTitle",
      count(*)::int AS count
    FROM whatsapp_sends
    WHERE run_id = $1
      AND event_id = $2
      AND status IN ('failed', 'skipped', 'deferred', 'interrupted')
    GROUP BY 1
    ORDER BY 2 DESC, 1`,
    [runId, env.eventId],
  );

  return result.rows;
};

/** The four states Meta reports on a message it accepted. */
export type ReceiptStatus = 'sent' | 'delivered' | 'read' | 'failed';

/** One status event, after the webhook's allow-list walk. */
export interface ReceiptEvent {
  wamid: string;
  status: ReceiptStatus;
  occurredAt: Date;
  errorCode: number | null;
  errorTitle: string | null;
}

/**
 * Records what Meta reported about one message.
 *
 * **Every write here is monotonic**, because status events arrive out of order,
 * arrive more than once, and are redelivered for anything Meta did not get a
 * `200` for. That is what makes at-least-once redelivery safe to accept rather
 * than something to deduplicate, and it is why this endpoint needs no nonce
 * store and no timestamp window:
 *
 * - `delivery_status` advances by rank only — `sent` < `delivered` < `read` —
 *   so a `delivered` arriving after a `read` is a no-op rather than a
 *   regression;
 * - `delivered_at` and `read_at` are `COALESCE`-guarded, so the first write
 *   wins and a repeat cannot move a timestamp;
 * - `undelivered` is terminal: once Meta has said a message failed, a later
 *   `delivered` for the same wamid does not overwrite it;
 * - and the reverse also holds — **a `failed` arriving after a `delivered` or a
 *   `read` is ignored**, status and error columns alike. Verification caught
 *   this one: an earlier revision let a stale `failed` turn a read message into
 *   `undelivered`, which is exactly the regression the rank rule exists to
 *   prevent. A message somebody demonstrably read was delivered, so such an
 *   event is a redelivery arriving out of order rather than news.
 *
 * Matched on `wamid` alone, which `whatsapp_sends_wamid_key` makes unique. The
 * event's `recipient_id` is Meta's `wa_id` rather than the number we sent to,
 * and nothing here matches on `to_e164`.
 *
 * **Deliberately not scoped to `env.eventId`.** Every other statement in this
 * file is; this one cannot be, because a wamid is Meta's identifier and carries
 * no event. The unique index is what makes that safe, and the column is only
 * ever written by the sender for this deployment's own messages.
 *
 * @param event - One status event from the callback.
 * @returns Whether a row matched. Zero is an ordinary outcome, not a failure.
 */
export const applyReceipt = async (event: ReceiptEvent): Promise<boolean> => {
  const result = await pg.query(
    `UPDATE whatsapp_sends
      SET delivery_status = CASE
            WHEN delivery_status = 'undelivered' THEN 'undelivered'
            WHEN $2 = 'failed'
              AND delivery_status IN ('delivered', 'read') THEN delivery_status
            WHEN $2 = 'failed' THEN 'undelivered'
            WHEN $2 = 'read' THEN 'read'
            WHEN $2 = 'delivered' AND delivery_status = 'read' THEN 'read'
            WHEN $2 = 'delivered' THEN 'delivered'
            WHEN delivery_status IS NULL THEN 'sent'
            ELSE delivery_status
          END,
        delivered_at = CASE
            WHEN $2 IN ('delivered', 'read') THEN coalesce(delivered_at, $3)
            ELSE delivered_at
          END,
        read_at = CASE
            WHEN $2 = 'read' THEN coalesce(read_at, $3)
            ELSE read_at
          END,
        delivery_error_code = CASE
            WHEN $2 = 'failed'
              AND coalesce(delivery_status, '') NOT IN ('delivered', 'read')
              THEN coalesce(delivery_error_code, $4)
            ELSE delivery_error_code
          END,
        delivery_error_title = CASE
            WHEN $2 = 'failed'
              AND coalesce(delivery_status, '') NOT IN ('delivered', 'read')
              THEN coalesce(delivery_error_title, $5)
            ELSE delivery_error_title
          END
    WHERE wamid = $1`,
    [
      event.wamid,
      event.status,
      event.occurredAt,
      event.errorCode,
      event.errorTitle,
    ],
  );

  return (result.rowCount ?? 0) > 0;
};

/** A finished run, and how much of it Meta could not deliver. */
export interface UndeliveredShare {
  run_id: string;
  sent: number;
  undelivered: number;
}

/**
 * The most recently finished run's delivery outcome.
 *
 * For the alert rule: a roster carries a scatter of undeliverable numbers, and
 * a run that is mostly undeliverable is a number-quality problem the operator
 * should hear about rather than read about later.
 *
 * @returns The run's counts, or `null` if the event has no finished run.
 */
export const findUndeliveredShare =
  async (): Promise<UndeliveredShare | null> => {
    const result = await pg.query<UndeliveredShare>(
      `SELECT r.run_id,
        count(s.*) FILTER (WHERE s.status = 'sent')::int AS sent,
        count(s.*) FILTER (WHERE s.delivery_status = 'undelivered')::int AS undelivered
      FROM whatsapp_runs r
      JOIN whatsapp_sends s ON s.run_id = r.run_id
      WHERE r.event_id = $1
        AND r.status IN ('done', 'failed')
      GROUP BY r.run_id, r.finished_at
      ORDER BY r.finished_at DESC NULLS LAST
      LIMIT 1`,
      [env.eventId],
    );

    return result.rows[0] ?? null;
  };
