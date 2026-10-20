import { mkdirSync } from 'node:fs';

import pino from 'pino';

import { env } from '../../config/env.ts';
import { REDACT_PATHS } from './redact-paths.ts';

const isProduction = env.nodeEnv === 'production';

/**
 * Where logs go.
 *
 * `pino.transport` with a `targets` array rather than `pino.multistream`.
 * Multistream would need `await build(…)` from pino-roll at module scope, and
 * this file sits low in the import graph — `shared/utils/mask.ts` imports it,
 * and much of the application imports that. It would be the first top-level
 * await in `src/` and would turn the whole graph async to buy nothing.
 * `pino.transport()` returns its stream synchronously.
 *
 * Two destinations, answering different questions, on two **independent**
 * switches:
 *
 * - **stdout**, everything at `LOG_LEVEL`. `NODE_ENV` picks its shape — pretty
 *   in development, JSON in production, where Docker's json-file driver rotates
 *   it. Container logs are removed with the container, so a `--force-recreate`
 *   mid-event takes the evening's history with it.
 * - **a rotating file**, `warn` and above, whenever `LOG_FILE_DIR` is set.
 *   Survives a recreate, and is the record archived at teardown —
 *   `deployment.md` notes that a hand-marked arrival is traceable only through
 *   a log line, and that line has to outlive the container for the note to be
 *   true.
 *
 * The file is deliberately **not** gated on `NODE_ENV`. Tying it to production
 * would make the one feature whose whole purpose is surviving a bad night
 * impossible to exercise before that night. Point `LOG_FILE_DIR` at a
 * repo-relative `logs/` in development and it behaves exactly as it will in
 * production.
 *
 * The root `level` below gates before either target does, so `LOG_LEVEL=error`
 * silences the file as well as stdout.
 *
 * Deliberately not `sync: true`. `warn` is not the low-volume tier it looks
 * like: http-logger maps every 4xx to it, and a mistyped ticket code is a 400,
 * so the check-in rush lands here. SonicBoom's default `minLength: 0` writes on
 * every call without buffering.
 */
const stdoutTarget = isProduction
  ? { target: 'pino/file', options: { destination: 1 }, level: env.logLevel }
  : {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss' },
      level: env.logLevel,
    };

// Ours rather than pino-roll's `mkdir: true`, which is not enough on its own:
// with `symlink: true` the transport calls symlinkSync() before the directory
// exists and dies with ENOENT on first boot. Measured against pino-roll 4.0.0 —
// symlink with a pre-existing directory works, symlink without one fails
// whether the path is absolute or relative.
//
// Synchronous and at module load, because the alternative is losing the boot
// error into a worker thread. On the read-only production container this is a
// no-op against the mounted volume; if the mount is missing it throws EROFS
// here, at boot, which is where that belongs.
if (env.logFileDir) mkdirSync(env.logFileDir, { recursive: true });

const fileTarget = {
  target: 'pino-roll',
  level: 'warn',
  options: {
    file: `${env.logFileDir}/app`,
    size: '10m',
    // `removeOtherLogFiles` is what makes `count` mean what it reads like.
    // Without it the limit applies only to files this process created, so every
    // restart during an event starts a fresh generation and the directory grows
    // without bound.
    limit: { count: 5, removeOtherLogFiles: true },
    mkdir: true,
    // Gives the runbook a stable `tail -f current.log` across rotations.
    symlink: true,
  },
};

/**
 * Base Pino logger instance. Redacts known-sensitive fields regardless
 * of which module logs them, and pretty-prints in non-production so
 * logs stay readable in dev without the pino-pretty dep leaking into
 * production output.
 */
export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: REDACT_PATHS,
    censor: '[REDACTED]',
  },
  transport: {
    targets: env.logFileDir ? [stdoutTarget, fileTarget] : [stdoutTarget],
  },
});
