/**
 * Runs k6 rungs against the load-test stack and records each as a row of
 * `loadtest/history/<session>.csv`. Method: docs/performance/load-testing.md, "How a
 * session is recorded and judged".
 *
 * From the root of a plain clone (the image build reads `.git`, which a
 * worktree does not have), with the load-test stack up, migrated and its
 * roster imported (docs/performance/load-testing.md, "Setting up"):
 *
 *   node scripts/loadtest/ladder.ts --host <label> --phase raffle --shedding off --find-knee
 *   node scripts/loadtest/ladder.ts --host <label> --phase raffle --scales 12,16 \
 *     --env LOAD_SHED_MAX_POOL_WAITING=10
 *
 * One invocation is one session: one phase, one configuration. It rebuilds and
 * restarts the app once, so the image matches the working tree and the
 * configuration the rows record. Linux only: it samples `/proc`.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { argv, env as shellEnv, exit, pid as runnerPid } from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';

import { MAX_IMPORT_ROWS } from '../../src/modules/admin/admin.import-input.ts';

import { APP_PATHS, appTreeHash, HARNESS_PATHS } from './history/code.ts';
import { CSV_HEADER, csvLine } from './history/csv.ts';
import { isWsl, parseCpuinfo, parseMeminfo, sameCpus } from './history/host.ts';
import { DEFAULT_KNEE_OPTIONS, nextKneeStep } from './history/knee.ts';
import {
  k6EnvLabel,
  OVERRIDABLE,
  parseLadderArgs,
  participantsFor,
  USAGE,
} from './history/ladder-args.ts';
import { isRecord, resultsFromSummary, SCHEMA } from './history/row.ts';
import {
  containerNames,
  otherLoad,
  parseDockerStats,
  parseLoadavg,
  parsePgActive,
  parseProcPidStat,
  parseProcStat,
  summarizeSamples,
} from './history/samples.ts';
import { judge } from './history/validity.ts';

import type { Outcome } from './history/knee.ts';
import type { LadderOptions } from './history/ladder-args.ts';
import type { ResultColumns, RungRow } from './history/row.ts';
import type {
  ContainerReading,
  HostReading,
  ProcReading,
  ProcSnapshot,
  SampleSet,
} from './history/samples.ts';

const PROJECT = 'pelicanpass-loadtest';
const APP = `${PROJECT}-app`;
const DB = `${PROJECT}-db`;
const CACHE = `${PROJECT}-cache`;
const COMPOSE = ['compose', '-f', 'compose.loadtest.yml'];

const HISTORY_DIR = 'loadtest/history';
const RESULTS_DIR = 'loadtest/results';
const FIXTURES = 'loadtest/fixtures.json';

/** Intel's package throttle time, in ms since boot. Absent on WSL2 and AMD. */
const THROTTLE_FILE =
  '/sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_total_time_ms';

/** Tries per `SCALE` before an invalid rung stops the session. */
const MAX_ATTEMPTS = 3;

const PG_QUERY = `SELECT state, coalesce(wait_event_type, ''), count(*)
  FROM pg_stat_activity
  WHERE datname = current_database() AND pid <> pg_backend_pid()
  GROUP BY 1, 2`;

/** Resolves the settings the app is running with, as `env.ts` sees them. */
const CONFIG_PROBE = `const { env } = await import('./src/config/env.ts');
console.log(JSON.stringify({
  ...env.loadShed,
  trustedIps: env.trustedIps !== '',
  overrides: env.rateLimitOverrides !== '',
  overridesValue: env.rateLimitOverrides,
}));`;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  env?: Record<string, string>;
  /** A file to feed to stdin. */
  stdin?: string;
  /** A file to write stdout and stderr to, instead of capturing them. */
  output?: string;
}

/**
 * Runs a command to completion.
 *
 * @param command - Executable.
 * @param args - Its arguments.
 * @param options - Extra environment, and files for stdin or output.
 */
const run = async (
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<Run> => {
  const stdin =
    options.stdin === undefined ? 'ignore' : openSync(options.stdin, 'r');
  const output =
    options.output === undefined ? 'pipe' : openSync(options.output, 'w');
  const child = spawn(command, args, {
    env: { ...shellEnv, ...options.env },
    stdio: [stdin, output, output],
  });
  let stdout = '';
  let stderr = '';

  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

  const [code] = (await once(child, 'close')) as [number | null];

  if (typeof stdin === 'number') closeSync(stdin);
  if (typeof output === 'number') closeSync(output);

  return { code: code ?? 1, stdout, stderr };
};

/**
 * Runs a command that must succeed.
 *
 * @throws {Error} With its stderr, if it exits non-zero.
 */
const must = async (
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<string> => {
  const result = await run(command, args, options);

  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${String(result.code)}\n${result.stderr.trim()}`,
    );
  }

  return result.stdout.trim();
};

const readIfExists = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf8') : null;

/**
 * Reads every process on the host. A process can exit between listing
 * `/proc` and reading it, so a failed read skips it.
 *
 * @param cgroups - Cgroup by `pid:start`, kept across calls: a process never
 *   changes container, so each is read once.
 */
const readProcs = (cgroups: Map<string, string>): ProcReading[] => {
  const procs: ProcReading[] = [];

  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;

    try {
      const stat = parseProcPidStat(
        readFileSync(`/proc/${entry}/stat`, 'utf8'),
      );

      if (!stat) continue;

      const key = `${String(stat.pid)}:${String(stat.start)}`;
      let cgroup = cgroups.get(key);

      if (cgroup === undefined) {
        cgroup = readFileSync(`/proc/${entry}/cgroup`, 'utf8').trim();
        cgroups.set(key, cgroup);
      }

      procs.push({ ...stat, cgroup });
    } catch {
      continue;
    }
  }

  return procs;
};

const readThrottleMs = (): number | null => {
  const value = Number.parseInt(readIfExists(THROTTLE_FILE) ?? '', 10);

  return Number.isFinite(value) ? value : null;
};

/**
 * Reads the settings the reset step needs from `.env`.
 *
 * @throws {Error} Naming any that are missing.
 */
const readDotenv = () => {
  const values = parseEnv(readFileSync('.env', 'utf8'));
  const keys = [
    'POSTGRES_DB',
    'POSTGRES_SUPERUSER',
    'POSTGRES_MIGRATOR_USER',
    'EVENT_ID',
    'REDIS_PASSWORD',
  ] as const;
  const missing = keys.filter((key) => !values[key]);

  if (missing.length > 0) {
    throw new Error(`.env is missing ${missing.join(', ')}`);
  }

  return Object.fromEntries(
    keys.map((key) => [key, values[key] ?? '']),
  ) as Record<(typeof keys)[number], string>;
};

/** Waits for the app's health check, which `compose.prod.yml` defines. */
const waitHealthy = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    const status = await run('docker', [
      'inspect',
      '-f',
      '{{.State.Health.Status}}',
      APP,
    ]);

    if (status.stdout.trim() === 'healthy') return;

    await sleep(2_000);
  }

  throw new Error(`${APP} did not become healthy within two minutes`);
};

/**
 * Reads the app's resolved load-shed settings and whether the two address
 * settings are set, from inside the running container.
 */
const readAppConfig = async () => {
  const out = await must('docker', [
    'exec',
    APP,
    'node',
    '--input-type=module',
    '-e',
    CONFIG_PROBE,
  ]);
  const parsed: unknown = JSON.parse(out.split('\n').at(-1) ?? '');

  if (
    !isRecord(parsed) ||
    typeof parsed.enabled !== 'boolean' ||
    typeof parsed.maxLagMs !== 'number' ||
    typeof parsed.maxPoolWaiting !== 'number' ||
    typeof parsed.retryAfterSeconds !== 'number' ||
    typeof parsed.trustedIps !== 'boolean' ||
    typeof parsed.overrides !== 'boolean' ||
    typeof parsed.overridesValue !== 'string'
  ) {
    throw new Error(`Unexpected configuration from the app: ${out}`);
  }

  return {
    load_shed_enabled: parsed.enabled,
    max_lag_ms: parsed.maxLagMs,
    max_pool_waiting: parsed.maxPoolWaiting,
    retry_after_s: parsed.retryAfterSeconds,
    trusted_ips_set: parsed.trustedIps,
    overrides_set: parsed.overrides,
    // The quotas are not sensitive, unlike the venue address in TRUSTED_IPS,
    // so the value is kept: two sweeps with different overrides must not
    // read as one configuration.
    rate_limit_overrides:
      parsed.overridesValue === '' ? null : parsed.overridesValue,
  };
};

/**
 * Counts the participants `prepare.sql` wrote to the fixtures k6 reads.
 */
const countParticipants = (): number => {
  const fixtures: unknown = JSON.parse(readFileSync(FIXTURES, 'utf8'));

  if (!Array.isArray(fixtures)) throw new Error(`${FIXTURES} is not an array`);

  return fixtures.filter((a) => isRecord(a) && a.role === 'participant').length;
};

/** Result columns for a rung k6 left no summary for. */
const noResults = (k6Exit: number): ResultColumns => ({
  k6_exit: k6Exit,
  thresholds_passed: null,
  served_p95: null,
  served_p99: null,
  served_max: null,
  phase_trend_p95: null,
  shed_rate: null,
  flow_shed_rate: null,
  flow_failed_rate: null,
  server_error_rate: null,
  rate_limited_rate: null,
  captcha: null,
  reqs: null,
  iterations: null,
  dropped: null,
  dropped_rate: null,
});

const percent = (rate: number | null) =>
  rate === null ? '-' : `${(rate * 100).toFixed(1)}%`;

const ms = (value: number | null) =>
  value === null ? '-' : `${value.toFixed(0)} ms`;

const main = async (options: LadderOptions): Promise<void> => {
  if (!existsSync('compose.loadtest.yml') || !statSync('.git').isDirectory()) {
    throw new Error(
      'Run from the root of a plain clone: the image build reads .git, which a worktree does not have',
    );
  }

  const dotenv = readDotenv();

  // Every overridable setting is passed, blank unless given, so a LOADTEST_*
  // left exported in the shell cannot leak into a session that did not ask
  // for it.
  const composeEnv = {
    ...Object.fromEntries(OVERRIDABLE.map((name) => [`LOADTEST_${name}`, ''])),
    ...options.composeEnv,
  };

  const git = (...args: string[]) => must('git', args);
  const code = {
    commit: await git('rev-parse', 'HEAD'),
    describe: await git('describe', '--tags', '--always', '--dirty'),
    branch: await git('rev-parse', '--abbrev-ref', 'HEAD'),
    dirty: (await git('status', '--porcelain', '--untracked-files=no')) !== '',
    app_tree: appTreeHash(
      await git('ls-tree', 'HEAD', '--', ...APP_PATHS),
      await git('diff', 'HEAD', '--', ...APP_PATHS),
    ),
    harness_tree: appTreeHash(
      await git('ls-tree', 'HEAD', '--', ...HARNESS_PATHS),
      await git('diff', 'HEAD', '--', ...HARNESS_PATHS),
    ),
  };

  const cpuinfo = parseCpuinfo(readFileSync('/proc/cpuinfo', 'utf8'));
  const kernel = readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim();
  const host = {
    host: options.host,
    cpu_model: cpuinfo.cpuModel,
    cores: cpuinfo.cores,
    ram_gib: parseMeminfo(readFileSync('/proc/meminfo', 'utf8')),
    kernel,
    wsl: isWsl(kernel),
    docker_version: await must('docker', [
      'version',
      '--format',
      '{{.Server.Version}}',
    ]),
  };

  // Units of /proc/<pid>/stat CPU times; 100 on every mainstream kernel.
  const clkTck = Number(await must('getconf', ['CLK_TCK'])) || 100;

  console.log(
    `${options.build ? 'Building and starting' : 'Starting'} the app at ${code.describe}…`,
  );
  await must(
    'docker',
    [...COMPOSE, 'up', '-d', ...(options.build ? ['--build'] : []), 'app'],
    { env: composeEnv },
  );
  await waitHealthy();

  const appPid = await must('docker', ['inspect', '-f', '{{.State.Pid}}', APP]);
  const affinity = () =>
    /^Cpus_allowed_list:\s*(\S+)/m.exec(
      readFileSync(`/proc/${appPid}/status`, 'utf8'),
    )?.[1] ?? '';

  if (options.appCpuset !== null) {
    // `docker update` pins through the cpuset cgroup controller, which rootless
    // Docker lacks unless it is delegated: it then warns and exits 0. The app's
    // processes belong to the operator there, so taskset pins them instead.
    await run('docker', ['update', '--cpuset-cpus', options.appCpuset, APP]);

    if (!sameCpus(affinity(), options.appCpuset)) {
      await must('taskset', ['-a', '-p', '-c', options.appCpuset, appPid]);
    }

    if (!sameCpus(affinity(), options.appCpuset)) {
      throw new Error(
        `Could not pin the app to CPUs ${options.appCpuset}: it may run on ${affinity()}`,
      );
    }
  }

  // What the app may actually run on, empty when that is every CPU.
  const allowed = affinity();
  const cpuset = sameCpus(
    allowed,
    readFileSync('/sys/devices/system/cpu/online', 'utf8'),
  )
    ? ''
    : allowed;
  const config = await readAppConfig();

  const iso = new Date().toISOString();
  const session = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z-${options.host}-${code.commit.slice(0, 7)}`;
  const file = `${HISTORY_DIR}/${session}.csv`;

  mkdirSync(HISTORY_DIR, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  // The k6 image runs as its own user, so it needs to write here too.
  chmodSync(RESULTS_DIR, 0o777);
  writeFileSync(file, `${CSV_HEADER}\n`);

  console.log(
    `Session ${session}: ${options.phase}, shedding ${config.load_shed_enabled ? `on (lag ${String(config.max_lag_ms)} ms, pool ${String(config.max_pool_waiting)})` : 'off'}${cpuset ? `, app on CPUs ${cpuset}` : ''}`,
  );

  /** Returns the event to doors-closed and empties Redis, as every rung starts. */
  const reset = async (): Promise<void> => {
    await must(
      'docker',
      [
        'exec',
        '-i',
        DB,
        'psql',
        '-U',
        dotenv.POSTGRES_MIGRATOR_USER,
        '-d',
        dotenv.POSTGRES_DB,
        '-v',
        `event_id=${dotenv.EVENT_ID}`,
      ],
      { stdin: 'scripts/loadtest/prepare.sql', output: FIXTURES },
    );
    // REDISCLI_AUTH, not -a, keeps the password off every process list.
    await must(
      'docker',
      ['exec', '-e', 'REDISCLI_AUTH', CACHE, 'redis-cli', 'FLUSHALL'],
      {
        env: { REDISCLI_AUTH: dotenv.REDIS_PASSWORD },
      },
    );
  };

  // The largest roster the session can need, checked before the first rung
  // rather than an hour in.
  const needed = Math.max(
    ...(options.scales ?? [options.maxScale]).map((scale) =>
      participantsFor(options.phase, scale, options.participants),
    ),
  );

  await reset();

  const available = countParticipants();

  if (available < needed) {
    throw new Error(
      `The roster holds ${String(available)} participants and this session can need ${String(needed)}. Import a larger one, in chunks the importer accepts:\n` +
        `  node scripts/loadtest/roster.ts --participants ${String(needed)} > .ignore/loadtest-roster.csv\n` +
        `  head -1 .ignore/loadtest-roster.csv > .ignore/roster-header.csv\n` +
        `  rm -f .ignore/roster-part-*\n` +
        `  tail -n +2 .ignore/loadtest-roster.csv | split -l ${String(MAX_IMPORT_ROWS)} - .ignore/roster-part-\n` +
        `  for f in .ignore/roster-part-*; do cat .ignore/roster-header.csv "$f" | docker compose -f compose.loadtest.yml --profile tools run --rm -T migrate node scripts/db/import-attendees.ts || break; done`,
    );
  }

  const runsAt = new Map<number, number>();

  /** Runs one rung and appends its row. */
  const runRung = async (scale: number): Promise<RungRow> => {
    const attempt = (runsAt.get(scale) ?? 0) + 1;

    runsAt.set(scale, attempt);

    const rung = `${options.phase}-s${String(scale)}-${String(attempt)}`;

    await reset();

    const participants = participantsFor(
      options.phase,
      scale,
      options.participants,
    );
    const containers: ContainerReading[] = [];
    const hostReadings: HostReading[] = [];
    const procs: ProcSnapshot[] = [];
    const cgroups = new Map<string, string>();
    const load1: number[] = [];
    const pgActive: number[] = [];
    const throttleStart = readThrottleMs();
    const startedAt = new Date().toISOString();

    const stats = spawn('docker', ['stats', '--format', '{{json .}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let pending = '';

    stats.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();

      const cut = pending.lastIndexOf('\n');

      if (cut === -1) return;

      containers.push(...parseDockerStats(pending.slice(0, cut), Date.now()));
      pending = pending.slice(cut + 1);
    });

    const hostTimer = setInterval(() => {
      const t = Date.now();
      const reading = parseProcStat(readFileSync('/proc/stat', 'utf8'), t);
      const load = parseLoadavg(readFileSync('/proc/loadavg', 'utf8'));

      if (reading) hostReadings.push(reading);
      if (load !== null) load1.push(load);
      procs.push({ t, procs: readProcs(cgroups) });
    }, 1_000);

    // At most one query at a time: a slow one under load must not pile up.
    const pgQueries = new Set<Promise<void>>();

    const pgTimer = setInterval(() => {
      if (pgQueries.size > 0) return;

      const query = run('docker', [
        'exec',
        DB,
        'psql',
        '-U',
        dotenv.POSTGRES_SUPERUSER,
        '-d',
        dotenv.POSTGRES_DB,
        '-Atc',
        PG_QUERY,
      ])
        .then((result) => {
          if (result.code === 0) pgActive.push(parsePgActive(result.stdout));
        })
        .finally(() => pgQueries.delete(query));

      pgQueries.add(query);
    }, 5_000);

    const name = `${session}-${rung}`;
    const k6 = await run(
      'docker',
      [
        ...COMPOSE,
        '--profile',
        'tools',
        'run',
        '--rm',
        'k6',
        'run',
        '-e',
        `PHASE=${options.phase}`,
        '-e',
        `IP_MODE=${options.ipMode}`,
        '-e',
        `SCALE=${String(scale)}`,
        '-e',
        `PARTICIPANTS=${String(participants)}`,
        ...Object.entries(options.k6Env).flatMap(([name, value]) => [
          '-e',
          `${name}=${value}`,
        ]),
        ...(options.smoke ? ['-e', 'SMOKE=true'] : []),
        `--summary-export=/results/${name}.json`,
        'run.ts',
      ],
      { env: composeEnv, output: `${RESULTS_DIR}/${name}.log` },
    );

    clearInterval(hostTimer);
    clearInterval(pgTimer);
    stats.kill();
    await once(stats, 'close');
    await Promise.all(pgQueries);

    const throttleEnd = readThrottleMs();
    const appLog = (await run('docker', ['logs', '--since', startedAt, APP]))
      .stdout;
    const summary = readIfExists(`${RESULTS_DIR}/${name}.json`);
    const samples: SampleSet = {
      containers,
      host: hostReadings,
      procs,
      load1,
      pgActive,
      throttleMs:
        throttleStart !== null && throttleEnd !== null
          ? { start: throttleStart, end: throttleEnd }
          : null,
      appLog: appLog.split('\n'),
    };

    const attribution = { project: PROJECT, runnerPid, clkTck };

    // Beside the k6 output, git-ignored: what a flagged rung is diagnosed from.
    // The process snapshots are reduced to their other-load series, since
    // every process once a second runs to tens of megabytes.
    writeFileSync(
      `${RESULTS_DIR}/${name}.samples.json`,
      JSON.stringify({
        ...samples,
        procs: undefined,
        appLog: undefined,
        other: otherLoad(procs, {
          ...attribution,
          names: containerNames(containers),
        }).series,
      }),
    );

    const unjudged = {
      schema: SCHEMA,
      session,
      rung,
      started_at: startedAt,
      note: options.note,
      ...host,
      app_cpuset: cpuset === '' ? null : cpuset,
      ...code,
      ...config,
      phase: options.phase,
      scale,
      ip_mode: options.ipMode,
      k6_env: k6EnvLabel(options.k6Env),
      roster_participants: participants,
      ...(summary === null
        ? noResults(k6.code)
        : resultsFromSummary(JSON.parse(summary), options.phase, k6.code)),
      ...summarizeSamples(samples, attribution),
    };
    const row: RungRow = { ...unjudged, ...judge(unjudged) };

    appendFileSync(file, `${csvLine(row)}\n`);

    console.log(
      [
        `${rung}:`,
        row.thresholds_passed === true ? 'pass' : 'FAIL',
        `p95 ${ms(row.served_p95)}, p99 ${ms(row.served_p99)},`,
        `shed ${percent(row.shed_rate)}, dropped ${percent(row.dropped_rate)},`,
        options.ipMode === 'spread'
          ? ''
          : `refused ${percent(row.rate_limited_rate)}, captchas ${String(row.captcha ?? '-')},`,
        `app CPU ${row.app_cpu_peak === null ? '-' : `${row.app_cpu_peak.toFixed(0)}%`}`,
        row.valid ? '' : `— INVALID: ${row.invalid_reason ?? ''}`,
      ]
        .join(' ')
        .trim(),
    );

    return row;
  };

  /** Runs a `SCALE` until a rung is valid, up to {@link MAX_ATTEMPTS}. */
  const runValid = async (scale: number): Promise<RungRow> => {
    let row: RungRow | null = null;

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      row = await runRung(scale);

      if (row.valid) return row;
    }

    throw new Error(
      `SCALE=${String(scale)}: ${String(MAX_ATTEMPTS)} invalid rungs in a row (${row?.invalid_reason ?? 'unknown'}). Stopping; the rows so far are in ${file}.`,
    );
  };

  const outcomes: Outcome[] = [];

  if (options.scales !== null) {
    for (const scale of options.scales) {
      const row = await runValid(scale);

      outcomes.push({ scale, passed: row.thresholds_passed === true });
    }

    console.log(`Done: ${String(outcomes.length)} rungs in ${file}`);
    return;
  }

  for (;;) {
    const step = nextKneeStep(outcomes, {
      ...DEFAULT_KNEE_OPTIONS,
      maxScale: options.maxScale,
    });

    if (step.done) {
      console.log(
        `${options.phase}: capacity SCALE=${String(step.capacity)}, ${
          step.knee === null
            ? `no knee up to ${String(options.maxScale)}`
            : `knee ${String(step.knee)}`
        }${step.unstable ? ', UNSTABLE (a repeat disagreed)' : ''}. Rows in ${file}`,
      );
      return;
    }

    const row = await runValid(step.scale);

    outcomes.push({
      scale: step.scale,
      passed: row.thresholds_passed === true,
    });
  }
};

let options: LadderOptions;

try {
  options = parseLadderArgs(argv.slice(2));
} catch (error) {
  console.error(
    `${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`,
  );
  exit(2);
}

try {
  await main(options);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exit(1);
}
