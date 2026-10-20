// First, so that dotenv has loaded before any other module body runs.
import { env } from './config/env.ts';

import app from './app.ts';
import redis, { initRedis } from './shared/db/redis.ts';
import pg from './shared/db/postgres.ts';
import { logStartupNotices } from './config/startup-notices.ts';
import { logger } from './shared/logger/logger.ts';
import { flushAlerts, sendAlert } from './shared/telemetry/alerts.ts';
import {
  flushCounters,
  seedLimiters,
  startCounters,
} from './shared/telemetry/counters.ts';
import { limiterRegistry } from './middleware/rate.middleware.ts';
import { flushEvents, startEventSink } from './shared/telemetry/events.ts';
import { startLoadMonitor } from './shared/telemetry/load.ts';
import { recordEvent } from './shared/telemetry/record.ts';
import { startAlertRules } from './shared/telemetry/rules.ts';
import { startWhatsappRunner } from './modules/admin/admin.whatsapp.runner.ts';

/**
 * How long an idle keep-alive connection stays open, in milliseconds.
 *
 * Caddy keeps idle upstream connections for `keepalive 30s` (`Caddyfile`).
 * The proxy must close an idle connection before the app does: at Node's
 * default of 5 s, Caddy could send a request down a connection Node was
 * closing at that moment, and that request would fail as a `502`. 5 s above
 * Caddy's value, and below `headersTimeout` (60 s), which must stay above it.
 */
const KEEP_ALIVE_TIMEOUT_MS = 35_000;

const connectRedisWithRetry = async (retries = 5, delay = 1000) => {
  for (let i = 0; i < retries; i++) {
    try {
      if (redis.status === 'end' || redis.status === 'wait') {
        await redis.connect();
      }

      await redis.ping();

      logger.info('Redis ready for commands');
      return;
    } catch {
      logger.warn({ attempt: i + 1, retries }, `Redis not ready, retrying`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  throw new Error('Redis failed to become ready after retries');
};

const connectPostgresWithRetry = async (retries = 10, delay = 1500) => {
  for (let i = 0; i < retries; i++) {
    try {
      await pg.query('SELECT 1');

      logger.info('Postgres ready for commands');
      return;
    } catch {
      logger.warn({ attempt: i + 1, retries }, `Postgres not ready, retrying`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }

  throw new Error('Postgres failed to become ready after retries');
};

/**
 * Last-resort exit path.
 *
 * Both handlers below are for state the process can no longer reason about, so
 * the only correct move is to report and go. The alert is flushed first because
 * the process is about to stop existing and an undelivered one is lost for
 * good — but flushing is bounded, because a hung webhook must not be able to
 * keep a broken process alive.
 */
const die = (err: unknown, kind: string): void => {
  logger.fatal({ err, kind }, 'Fatal error, shutting down');

  recordEvent({
    severity: 'fatal',
    kind: 'security',
    code: 'UNCAUGHT',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  sendAlert({
    severity: 'critical',
    title: 'Process crashed and is restarting',
    fingerprint: `fatal:${kind}`,
    means: `An ${kind} escaped every handler, so the process could no longer reason about its own state and is exiting. Docker will restart it.`,
    check:
      'The durable log has the stack. This is a bug rather than a blip — expect it to recur.',
    fields: {
      message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    },
  });

  // Both raced inside one budget rather than sequenced. The process is going
  // down and the pool may be the reason it is; a flush that cannot finish must
  // not be able to keep a broken process alive.
  void Promise.allSettled([flushAlerts(3_000), flushEvents(3_000)]).finally(
    () => {
      process.exit(1);
    },
  );
};

process.on('uncaughtException', (err) => {
  die(err, 'uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  die(reason, 'unhandledRejection');
});

const start = async () => {
  try {
    initRedis();
    await connectRedisWithRetry();
    await connectPostgresWithRetry();

    logStartupNotices(logger, env);

    const server = app.listen(env.port, () => {
      logger.info(`Server running on port ${String(env.port)}`);
    });

    server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

    // Before the counters start, so the panel has every limiter and its real
    // ceiling from the first snapshot rather than from the first request.
    // Passed in rather than imported by `counters.ts`, which `rate.middleware`
    // already depends on — the other direction would be a cycle.
    seedLimiters(
      limiterRegistry().map((info) => ({
        prefix: info.prefix,
        ceiling: info.points,
        duration: info.duration,
        basis: info.basis,
        keyedOn: info.keyedOn,
        protects: info.protects,
        tier: info.tier,
      })),
    );

    const stopCounters = startCounters();
    const stopEvents = startEventSink();
    const stopRules = startAlertRules();
    const stopLoadMonitor = startLoadMonitor();

    // Awaited, so the boot sweep has paused any run a previous process left
    // running before the first tick can claim from it.
    let stopWhatsapp = (): void => undefined;

    if (env.whatsapp.enabled) {
      stopWhatsapp = await startWhatsappRunner();
    } else {
      logger.info('WhatsApp runner not started: WHATSAPP_ENABLED is false');
    }

    sendAlert({
      severity: 'warn',
      title: 'Application started',
      // Not deduplicated against anything: every boot is worth seeing, and a
      // boot nobody asked for is the most interesting kind.
      fingerprint: `boot:${String(Date.now())}`,
      // The pair is read by what is *missing*, and nobody works that out
      // unprompted — which is exactly why it belongs in the message rather
      // than only in the runbook.
      means:
        'The process came up. If no "Application stopped cleanly" arrived just before this, it did not stop deliberately — that absence is the crash signal, because nothing can announce a SIGKILL.',
      check:
        'Scroll up. A clean stop above this is a deploy; nothing above it is a crash.',
      fields: { release: env.releaseId, port: env.port },
    });

    /**
     * Graceful shutdown.
     *
     * There was no signal handler here at all, so `docker compose down` and
     * every `--force-recreate` killed the process outright: pino's transport
     * runs in a worker thread, so buffered lines could be lost, and no
     * shutdown notice was possible. That is what made the durable log file
     * untrustworthy at exactly the moment it is archived.
     *
     * It also buys the boot/shutdown pair its meaning. A clean stop says so; a
     * crash says nothing and is followed by a boot notice alone. Telling those
     * two apart afterwards is most of what you want at 20:00.
     *
     * Bounded well inside Docker's ten-second grace period, or the stop this
     * exists to announce becomes a SIGKILL.
     */
    let shuttingDown = false;

    const shutdown = (signal: string): void => {
      if (shuttingDown) return;

      shuttingDown = true;

      logger.info({ signal }, 'Shutting down');
      stopRules();
      stopLoadMonitor();
      // First, so no new message starts while the rest shuts down. The one in
      // flight, if any, is not waited for — see the runner's JSDoc.
      stopWhatsapp();

      sendAlert({
        severity: 'warn',
        title: 'Application stopped cleanly',
        fingerprint: `shutdown:${String(Date.now())}`,
        means:
          'A deliberate stop: connections drained, telemetry flushed, logs written. Nothing was lost.',
        check: 'Nothing. This is what a planned restart looks like.',
        fields: { release: env.releaseId, signal },
      });

      server.close(() => {
        void (async () => {
          // Events before alerts, and both before the pool closes. The last
          // rows of the evening are written immediately before teardown, and
          // dropping them here would defeat the graceful shutdown that exists
          // to make the record trustworthy.
          stopCounters();
          stopEvents();
          await flushCounters();
          await flushEvents(3_000);
          await flushAlerts(3_000);

          await Promise.allSettled([pg.end(), redis.quit()]);

          logger.flush();
          process.exit(0);
        })();
      });

      // A connection that never closes must not hold the container open past
      // the grace period; past this point an abrupt exit is the better outcome.
      setTimeout(() => {
        logger.warn('Shutdown timed out, exiting');
        process.exit(0);
      }, 8_000).unref();
    };

    process.on('SIGTERM', () => {
      shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
      shutdown('SIGINT');
    });
  } catch (err) {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  }
};

void start();
