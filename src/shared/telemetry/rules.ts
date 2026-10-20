import { env } from '../../config/env.ts';
import {
  findStalledRun,
  findUndeliveredShare,
} from '../../modules/admin/admin.whatsapp.repository.ts';
import { checkinOpensAt } from '../../modules/checkin/checkin.window.ts';
import { isCheckinFailureBudgetExhausted } from '../../middleware/rate.middleware.ts';
import { logger } from '../logger/logger.ts';

import { sendAlert } from './alerts.ts';
import { probeDependencies } from './probes.ts';
import { recordEvent } from './record.ts';
import { total } from './window.ts';

const TICK_MS = 30_000;

/**
 * A dependency is reported down only after this many consecutive failed probes.
 *
 * One is too few. A single ping timing out during a garbage-collection pause is
 * not an outage, and a false critical at 20:00 costs more than thirty seconds of
 * delay does.
 */
const FAILURES_BEFORE_ALERT = 2;

/** Minutes of zero completions before the door counts as stalled. */
const STALL_MINUTES = 3;

const consecutiveFailures = { redis: 0, postgres: 0 };

/** Last observed state of the global check-in budget, for edge detection. */
let checkinBudgetExhausted = false;

let timer: NodeJS.Timeout | null = null;

/**
 * Whether either audience's check-in window has opened.
 *
 * Uses `checkinOpensAt`, not `isCheckinOpen` — the latter takes a `Request` so
 * it can honour the landing bypass cookie, and there is no request on a timer.
 * A `null` window means there is no curtain at all, which reads as open.
 */
const checkinWindowOpen = (): boolean => {
  const now = Date.now();

  return (['volunteer', 'participant'] as const).some((role) => {
    const opensAt = checkinOpensAt(role);

    return opensAt === null || now >= opensAt;
  });
};

const evaluateDependency = (
  name: 'redis' | 'postgres',
  ok: boolean,
  detail: string | undefined,
): void => {
  if (ok) {
    if (consecutiveFailures[name] >= FAILURES_BEFORE_ALERT) {
      sendAlert({
        severity: 'critical',
        title: `${name === 'redis' ? 'Redis' : 'Postgres'} is back`,
        fingerprint: `dep:${name}:up`,
        means:
          'The dependency is answering again. Whatever it broke should now work.',
        check:
          name === 'redis'
            ? 'The Porta panel — check-ins should be completing again.'
            : 'The dashboard should be populating again.',
        fields: { dependency: name },
      });
    }

    consecutiveFailures[name] = 0;

    return;
  }

  consecutiveFailures[name] += 1;

  if (consecutiveFailures[name] === FAILURES_BEFORE_ALERT) {
    sendAlert({
      severity: 'critical',
      title:
        name === 'redis'
          ? 'Redis is unreachable — sessions are gone'
          : 'Postgres is unreachable — nothing can be written',
      fingerprint: `dep:${name}:down`,
      means:
        name === 'redis'
          ? 'Sessions live in Redis, so every surface answers 401 and /checkin returns 500. The container stays green and rate limiting keeps working on its memory tier, so nothing else will point here.'
          : 'No check-in, redemption or draw can be recorded. The app keeps serving pages.',
      check:
        name === 'redis'
          ? 'docker compose ps cache, then logs cache.'
          : 'docker compose ps db, then logs db. Check disk before assuming the process.',
      fields: {
        dependency: name,
        consecutiveFailures: consecutiveFailures[name],
        detail: detail ?? 'no detail',
      },
    });
  }
};

/**
 * The door is taking traffic but nobody is getting through.
 *
 * No other signal catches this condition: with Redis gone the container stays green, Caddy keeps routing, and
 * every surface answers 401 while the room fills up. Requests without
 * completions is what that looks like from inside the process.
 */
const evaluateDoor = (): void => {
  if (!checkinWindowOpen()) return;

  // `checkin.req`, not `http.req`. The latter counts every response the process
  // makes — static assets, the health probe, and the metrics dashboard's own
  // five-second poll, which is 36 requests across this window on its own. This
  // rule fired on an open dashboard with nobody at the door, every ten minutes,
  // for as long as a window was open: the volunteer one opens four hours before
  // the event, so that was most of the afternoon. An alert that cries wolf
  // before the rush is worse than no alert, because this is the one that means
  // the room is filling up.
  const requests = total('checkin.req', STALL_MINUTES);
  const completions = total('checkin.complete', STALL_MINUTES);

  // A quiet door is not a stalled one. Thirty check-in requests over three
  // minutes is roughly five to ten attempted check-ins — `ipLimiter`'s own note
  // pins one at "3 requests at best and about 6 in practice" — so this is a
  // queue rather than a passer-by.
  if (requests < 30 || completions > 0) return;

  sendAlert({
    severity: 'critical',
    title: 'Queue at the door — no check-ins completing',
    fingerprint: 'door:stalled',
    means:
      'People are trying to check in and none of them can finish. This is the alert that means the room is filling up.',
    check:
      '/readyz first — it names the failing dependency. Almost always Redis.',
    fields: {
      requests,
      completions,
      windowMinutes: STALL_MINUTES,
    },
  });
};

const evaluateRates = (): void => {
  const serverErrors = total('http.5xx', 1);

  if (serverErrors > 5) {
    sendAlert({
      severity: 'error',
      title: `Server errors above normal (${String(serverErrors)}/min)`,
      fingerprint: 'rate:5xx',
      means: 'Requests are failing outright, not being refused politely.',
      check:
        'The Errors panel — open the loudest signature for the scrubbed message.',
      fields: { perMinute: serverErrors, threshold: 5 },
    });
  }

  const refusals = total('http.429', 1);

  if (refusals > 50) {
    sendAlert({
      severity: 'warn',
      title: `Rate limits are refusing traffic (${String(refusals)}/min)`,
      fingerprint: 'rate:429',
      means:
        'Something is being turned away. Often the venue behind one carrier NAT rather than abuse.',
      check:
        'The Limits panel. Read the fan-out column: many sessions on one address is a NAT and belongs in TRUSTED_IPS; one session repeating is not.',
      fields: { perMinute: refusals, threshold: 50 },
    });
  }

  // Its own rule rather than part of the 5xx one: a shed is the process
  // protecting itself, and the 5xx wording ("failing outright") would send
  // somebody hunting for a bug that is not there.
  const shed = total('http.shed', 1);

  if (shed > 20) {
    sendAlert({
      severity: 'error',
      title: `Server is shedding load (${String(shed)}/min)`,
      fingerprint: 'load:shedding',
      means:
        'The event loop or the database pool is saturated, so public requests are being answered 503 to let the process recover. Attendees see a "try again in a few seconds" page.',
      check:
        'The durable log has "Load shedding started" with the lag and pool queue that tripped it. Host CPU and the Postgres panel say which one; a sustained shed needs capacity, not a restart.',
      fields: { perMinute: shed, threshold: 20 },
    });
  }

  // Deferred from phase 1 to "the phase that enables it", because a rule that
  // can never fire is worse than no rule: nothing produced `client.error` until
  // the ingest endpoint existed.
  //
  // The threshold is per-minute rather than per-signature on purpose. One
  // attendee with a hostile browser extension throws all evening and is noise;
  // twenty in a minute is a bundle that does not work on a class of phone, and
  // that is worth interrupting somebody for.
  const clientErrors = total('client.error', 1);

  if (clientErrors > 20) {
    sendAlert({
      severity: 'warn',
      title: `Frontend errors above normal (${String(clientErrors)}/min)`,
      fingerprint: 'rate:client-error',
      means:
        'The browser bundle is breaking on attendees’ phones — usually one class of device or browser.',
      check:
        'The Errors panel groups these by signature; one signature with a high count is one bug, not many.',
      fields: { perMinute: clientErrors, threshold: 20 },
    });
  }

  const adminLoginFailures = total('admin.login.blocked', 1);

  if (adminLoginFailures > 0) {
    sendAlert({
      severity: 'critical',
      title: 'Admin sign-in blocked after repeated failures',
      fingerprint: 'security:admin-login-budget',
      means:
        'Ten failed sign-ins for one username inside fifteen minutes, so that username is now locked out. Either somebody mistyped repeatedly or somebody is guessing.',
      check:
        'The log line carries the username — deliberately not this message. Grep the durable log for "Admin login budget exhausted".',
      fields: { perMinute: adminLoginFailures },
    });
  }
};

const tick = async (): Promise<void> => {
  const { redis, postgres } = await probeDependencies();

  evaluateDependency('redis', redis.ok, redis.error);
  evaluateDependency('postgres', postgres.ok, postgres.error);

  evaluateRates();
  evaluateDoor();

  // Touches Redis, so it is evaluated last and its failure is swallowed
  // separately: a Redis outage must surface as the dependency rule above, not
  // as this one going quiet or taking the whole tick down with it.
  try {
    const exhausted = await isCheckinFailureBudgetExhausted();

    if (exhausted) {
      sendAlert({
        severity: 'warn',
        title: 'Captcha now forced for every arrival',
        fingerprint: 'security:checkin-budget',
        means:
          'Thirty ticket lookups failed inside a minute, so the door has raised a captcha for everyone until the budget refills. Check-in still works; it is just slower.',
        check:
          'Expected during a rush of mistyped codes. If it persists, the roster or the printed codes are wrong.',
        fields: { effect: 'every arrival now sees a captcha' },
      });
    }

    // Recorded on the edge only. The alert deduplicates by fingerprint, but a
    // row does not: storing this every tick would write one every thirty
    // seconds for as long as the budget stayed spent, and the interesting fact
    // is that it changed, not that it is still true.
    if (exhausted !== checkinBudgetExhausted) {
      checkinBudgetExhausted = exhausted;

      recordEvent({
        severity: 'warn',
        kind: 'security',
        code: 'CHECKIN_BUDGET',
        message: exhausted
          ? 'Global check-in failure budget exhausted, captcha forced'
          : 'Global check-in failure budget recovered',
        fields: { exhausted },
      });
    }
  } catch {
    // The dependency rule owns this failure.
  }

  if (env.whatsapp.enabled) {
    try {
      await evaluateWhatsapp();
      await evaluateUndelivered();
    } catch {
      // The dependency rule owns this failure too.
    }
  }
};

/** Minutes a running WhatsApp run may go without a claim. */
const WHATSAPP_STALL_MINUTES = 5;

/**
 * A WhatsApp run that is running and not sending.
 *
 * At one message a second, five minutes without a claim is three hundred
 * missing messages. The longest legitimate gap is one row's sixty-second
 * back-off, so this cannot fire on a healthy run.
 */
const evaluateWhatsapp = async (): Promise<void> => {
  const runId = await findStalledRun(WHATSAPP_STALL_MINUTES);

  if (!runId) return;

  sendAlert({
    severity: 'error',
    title: 'WhatsApp run is not sending',
    fingerprint: `whatsapp:stalled:${runId}`,
    means:
      'A run is marked running but has claimed nothing for five minutes. Nobody is being messaged, and the screen still says it is in progress.',
    check:
      'The log for "WhatsApp runner tick failed". If there is none, the runner did not start: WHATSAPP_ENABLED and the boot log.',
    fields: { runId, windowMinutes: WHATSAPP_STALL_MINUTES },
  });
};

/** Sent messages a finished run needs before its delivery share means anything. */
const UNDELIVERED_MIN_SENT = 20;

/** Share of a run Meta could not deliver before it stops being a scatter. */
const UNDELIVERED_SHARE = 0.3;

/**
 * A finished run most of which never arrived.
 *
 * A roster always carries a few numbers that no longer exist, and those are
 * noise. A run where a third of the messages came back undelivered is a
 * number-quality problem — a stale import, a column of landlines — and the
 * operator should hear it rather than find it in the table afterwards.
 *
 * Deliberately evaluated on **finished** runs only: receipts keep arriving for
 * minutes or hours after the last send, so the share means nothing until the
 * sending stops.
 */
const evaluateUndelivered = async (): Promise<void> => {
  const run = await findUndeliveredShare();

  if (!run || run.sent < UNDELIVERED_MIN_SENT) return;

  const share = run.undelivered / run.sent;

  if (share <= UNDELIVERED_SHARE) return;

  sendAlert({
    severity: 'warn',
    title: `WhatsApp run mostly undelivered (${String(Math.round(share * 100))}%)`,
    fingerprint: `whatsapp:undelivered:${run.run_id}`,
    means:
      'Meta accepted these messages and then could not deliver them. A scatter is ordinary; this proportion points at the numbers rather than at the sending.',
    check:
      'Mensagens: the failure table, and a sample of the numbers in the roster. Usually a stale import.',
    fields: {
      runId: run.run_id,
      sent: run.sent,
      undelivered: run.undelivered,
    },
  });
};

/**
 * Starts the evaluation loop.
 *
 * @returns A function that stops it, for the shutdown path.
 */
export const startAlertRules = (): (() => void) => {
  if (timer) return () => undefined;

  timer = setInterval(() => {
    // The whole tick is wrapped. A rule that throws must not kill the interval
    // and silently end all alerting — a failure mode indistinguishable from
    // "nothing is wrong", which is the worst shape an observability bug can
    // take.
    void tick().catch((err: unknown) => {
      logger.error({ err }, 'Alert rule evaluation failed');
    });
  }, TICK_MS);

  // Never hold the process open on our account.
  timer.unref();

  logger.info(
    { tickMs: TICK_MS, alertsEnabled: env.alerts.enabled },
    'Alert rules started',
  );

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
};
