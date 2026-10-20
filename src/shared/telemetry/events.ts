import { env } from '../../config/env.ts';
import pg from '../db/postgres.ts';
import { logger } from '../logger/logger.ts';

import { scrub } from './scrub.ts';
import type { TelemetryFields } from './scrub.ts';
import { count } from './counters.ts';

/** One occurrence, shaped for the `app_events` columns. */
export interface EventRow {
  readonly severity: string;
  readonly kind: string;
  readonly code: string | undefined;
  readonly fingerprint: string;
  readonly message: string;
  readonly route: string | undefined;
  readonly statusCode: number | undefined;
  readonly requestId: string | undefined;
  readonly actorType: string | undefined;
  readonly actorId: string | undefined;
  readonly ip: string | undefined;
  readonly fields: TelemetryFields | undefined;
}

/**
 * Columns in the order the insert names them. `id` and `occurred_at` carry
 * defaults; `event_id` and `release_id` come from the environment rather than
 * from a call site, so nothing can file a row under the wrong event or claim
 * the wrong build.
 */
const COLUMNS = [
  'event_id',
  'severity',
  'kind',
  'code',
  'fingerprint',
  'message',
  'route',
  'status_code',
  'request_id',
  'actor_type',
  'actor_id',
  'ip',
  'release_id',
  'context',
];

/** Flush when the queue reaches this, without waiting for the timer. */
const BATCH_SIZE = 50;

const FLUSH_INTERVAL_MS = 1_000;

/**
 * The retention sweep runs on its own, far slower cadence.
 *
 * Bolting it to the flush timer would issue the same `DELETE` six hundred times
 * a minute to do a job that is not time-sensitive by hours.
 */
const PURGE_INTERVAL_MS = 10 * 60_000;

/**
 * Hard ceiling on the queue.
 *
 * Telemetry is best-effort: if Postgres is slow or gone, the queue is what
 * would grow without bound while every request keeps adding to it. Dropping is
 * the correct failure — the alternative is telemetry causing the outage it
 * exists to report.
 */
const MAX_QUEUED = 500;

const queue: EventRow[] = [];

/** Reset each time it is reported, so the log line reads per-cycle. */
let dropped = 0;

let flushTimer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let flushing = false;

/**
 * Queues one occurrence.
 *
 * Never throws and never awaits. Callers are on a request path and have already
 * done the thing worth recording.
 *
 * @param row - The occurrence.
 */
export const enqueueEvent = (row: EventRow): void => {
  if (queue.length >= MAX_QUEUED) {
    dropped += 1;
    count('telemetry.dropped');

    return;
  }

  queue.push(row);

  if (queue.length >= BATCH_SIZE) void flush();
};

/**
 * Removes `\u0000` from every string in a value, keys included.
 *
 * Postgres refuses the byte in `text` and in `jsonb`, and one such value fails
 * the whole statement. Telemetry values come from request paths and from the
 * public `/client-errors` route, so they cannot be trusted to be free of it.
 *
 * @param value - A string, or an array or object that may contain strings.
 * @returns The same shape with the byte removed.
 */
const stripNul = <T>(value: T): T => {
  if (typeof value === 'string') {
    return value.replaceAll('\u0000', '') as T;
  }

  if (Array.isArray(value)) return value.map(stripNul) as T;

  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        stripNul(key),
        stripNul(item),
      ]),
    ) as T;
  }

  return value;
};

/**
 * Builds the multi-row `INSERT` for a batch.
 *
 * One statement rather than one per row: at the door a burst of 4xx arrives
 * together, and fifty round trips would put telemetry in the same latency
 * budget as check-in itself.
 *
 * Parameter count is bounded by {@link BATCH_SIZE} × {@link COLUMNS} = 700,
 * comfortably under Postgres' 65535 limit. That headroom is why the batch cap
 * can move without arithmetic, but it is not unlimited — raising it past ~4600
 * rows would not be.
 *
 * @param rows - The batch to write.
 * @returns The statement text and its parameters.
 */
const buildInsert = (rows: EventRow[]): { text: string; values: unknown[] } => {
  const values: unknown[] = [];

  const tuples = rows.map((source, index) => {
    const row = stripNul(source);
    const offset = index * COLUMNS.length;

    values.push(
      env.eventId,
      row.severity,
      row.kind,
      row.code ?? null,
      row.fingerprint,
      row.message,
      row.route ?? null,
      row.statusCode ?? null,
      row.requestId ?? null,
      row.actorType ?? null,
      row.actorId ?? null,
      row.ip ?? null,
      env.releaseId,
      row.fields ? JSON.stringify(scrub(row.fields)) : null,
    );

    const placeholders = COLUMNS.map(
      (_column, column) => `$${String(offset + column + 1)}`,
    ).join(', ');

    return `(${placeholders})`;
  });

  return {
    text: `INSERT INTO app_events (${COLUMNS.join(', ')}) VALUES ${tuples.join(', ')}`,
    values,
  };
};

/**
 * Whether a failed statement was refused by Postgres for its content.
 *
 * Only a SQLSTATE outside the connection (08), resource (53) and operator (57)
 * classes says the fault is in a row rather than in the database, which is the
 * only case where writing the rows one at a time can save any of them.
 */
const isRowFault = (err: unknown): boolean => {
  const code = (err as { code?: unknown } | null)?.code;

  return (
    typeof code === 'string' &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !/^(08|53|57)/.test(code)
  );
};

/**
 * Writes a failed batch one row at a time, so a bad row costs only itself.
 *
 * A dropped row is logged by its kind and error code, never its content.
 */
const writeRowByRow = async (batch: EventRow[]): Promise<void> => {
  for (const row of batch) {
    try {
      const { text, values } = buildInsert([row]);

      await pg.query(text, values);
    } catch (err) {
      count('telemetry.dropped');

      logger.error(
        { kind: row.kind, errCode: (err as { code?: unknown }).code },
        'Telemetry event lost: could not write app_events row',
      );
    }
  }
};

/**
 * Writes whatever is queued.
 *
 * The batch is the normal path. If Postgres refuses it for the content of a
 * row, the rows are retried singly so one bad row drops only itself. Any other
 * failure drops the batch rather than requeueing it. A retry queue outlives the
 * incident and, if Postgres is the thing that is broken, grows until it is the
 * second problem — the same reasoning `alerts.ts` applies to a failed webhook.
 */
const flush = async (): Promise<void> => {
  if (flushing || queue.length === 0) return;

  flushing = true;

  const batch = queue.splice(0, BATCH_SIZE);

  try {
    const { text, values } = buildInsert(batch);

    await pg.query(text, values);
  } catch (err) {
    if (batch.length > 1 && isRowFault(err)) {
      await writeRowByRow(batch);
    } else {
      count('telemetry.dropped');

      logger.error(
        { err, batchSize: batch.length },
        'Telemetry batch lost: could not write app_events',
      );
    }
  } finally {
    flushing = false;
  }

  // Reported here rather than per drop: overflow arrives in bursts of hundreds,
  // and a line each would be the flood it is warning about.
  if (dropped > 0) {
    logger.warn(
      { dropped, queued: queue.length, cap: MAX_QUEUED },
      'Telemetry events dropped: queue is at capacity',
    );

    dropped = 0;
  }
};

/**
 * Deletes rows past the retention window.
 *
 * Runs as the application role, which `017` grants `DELETE` on this table for
 * exactly this statement. Bounded by `occurred_at`, so it cannot touch a row
 * written while it runs.
 */
const purge = async (): Promise<void> => {
  try {
    const cutoff = new Date(Date.now() - env.telemetryEventRetention);

    const result = await pg.query(
      'DELETE FROM app_events WHERE occurred_at < $1',
      [cutoff],
    );

    if (result.rowCount) {
      logger.info(
        { removed: result.rowCount, cutoff },
        'Telemetry retention sweep',
      );
    }
  } catch (err) {
    logger.error({ err }, 'Telemetry retention sweep failed');
  }
};

/**
 * Starts the flush and retention timers.
 *
 * @returns A function that stops them, for the shutdown path.
 */
export const startEventSink = (): (() => void) => {
  if (flushTimer) return () => undefined;

  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  purgeTimer = setInterval(() => {
    void purge();
  }, PURGE_INTERVAL_MS);

  // Neither holds the process open on our account.
  flushTimer.unref();
  purgeTimer.unref();

  logger.info(
    {
      batchSize: BATCH_SIZE,
      flushMs: FLUSH_INTERVAL_MS,
      retentionMs: env.telemetryEventRetention,
    },
    'Telemetry event sink started',
  );

  return () => {
    if (flushTimer) clearInterval(flushTimer);
    if (purgeTimer) clearInterval(purgeTimer);

    flushTimer = null;
    purgeTimer = null;
  };
};

/**
 * Drains the queue before the pool closes.
 *
 * Called from the shutdown path ahead of `pg.end()`. Without it the last
 * seconds of the evening — the ones written immediately before teardown — are
 * discarded by the graceful shutdown that exists to make the record
 * trustworthy.
 *
 * @param timeoutMs - How long to keep draining before giving up.
 */
export const flushEvents = async (timeoutMs = 3_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (queue.length > 0 && Date.now() < deadline) {
    await flush();
  }

  if (queue.length > 0) {
    logger.warn(
      { pending: queue.length },
      'Shutting down with telemetry events unwritten',
    );
  }
};
