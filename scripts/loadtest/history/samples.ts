/**
 * Host and stack samples taken during a rung, and their reduction to the
 * sample columns of its row.
 *
 * The parsers take the raw text of each source, so the runner does only I/O:
 * a streaming `docker stats --format '{{json .}}'`, `/proc/stat`,
 * `/proc/<pid>/stat` and `/proc/<pid>/cgroup`, `/proc/loadavg`, the Intel
 * package throttle counter, `pg_stat_activity` through `psql -At`, and the
 * app log.
 */

import { isRecord } from './row.ts';

import type { RungRow } from './row.ts';

/** One container's CPU at one moment, in percent of one core. */
export interface ContainerReading {
  t: number;
  /** The full container ID, which is what its processes' cgroup names. */
  id: string | null;
  name: string;
  cpu: number;
}

/** One process at one moment. `ticks` is user plus system CPU since it began. */
export interface ProcReading {
  pid: number;
  ppid: number;
  /** Start time in clock ticks since boot: with `pid`, it names the process. */
  start: number;
  comm: string;
  ticks: number;
  cgroup: string;
}

/** Every process on the host at one moment. */
export interface ProcSnapshot {
  t: number;
  procs: readonly ProcReading[];
}

/** Cumulative CPU time across the host, from the `cpu` line of `/proc/stat`. */
export interface HostReading {
  t: number;
  busy: number;
  total: number;
}

export interface SampleSet {
  containers: readonly ContainerReading[];
  host: readonly HostReading[];
  procs: readonly ProcSnapshot[];
  load1: readonly number[];
  pgActive: readonly number[];
  /** `package_throttle_total_time_ms` before and after, where the host has it. */
  throttleMs: { start: number; end: number } | null;
  appLog: readonly string[];
}

export type SampleColumns = Pick<
  RungRow,
  | 'app_cpu_p95'
  | 'app_cpu_peak'
  | 'db_cpu_peak'
  | 'k6_cpu_peak'
  | 'host_cpu_peak'
  | 'other_load_p95'
  | 'other_top'
  | 'throttle_ms'
  | 'load1_peak'
  | 'pg_active_peak'
  | 'shed_starts'
  | 'pool_waiting_at_start_max'
  | 'lag_at_start_max'
>;

/**
 * Parses what a streaming `docker stats --format '{{json .}}'` wrote.
 *
 * Without a terminal, docker still prefixes each frame with screen-clearing
 * escape codes, so each line is cut to its outermost braces. A line that does
 * not parse, or lacks a name or a CPU figure, is skipped: the stream is a
 * sample, not a record.
 *
 * @param text - One or more lines of output.
 * @param t - When they were read, in epoch milliseconds.
 */
export const parseDockerStats = (
  text: string,
  t: number,
): ContainerReading[] => {
  const readings: ContainerReading[] = [];

  for (const line of text.split('\n')) {
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');

    if (start === -1 || end < start) continue;

    let parsed: unknown;

    try {
      parsed = JSON.parse(line.slice(start, end + 1));
    } catch {
      continue;
    }

    if (!isRecord(parsed)) continue;

    const { Container: container, Name: name, CPUPerc: cpuPerc } = parsed;
    const cpu = typeof cpuPerc === 'string' ? Number.parseFloat(cpuPerc) : NaN;

    if (typeof name !== 'string' || !Number.isFinite(cpu)) continue;

    // `Container` is the full ID when `docker stats` is given no names.
    const id =
      typeof container === 'string' && /^[0-9a-f]{64}$/.test(container)
        ? container
        : null;

    readings.push({ t, id, name, cpu });
  }

  return readings;
};

/**
 * Parses the aggregate `cpu` line of `/proc/stat`.
 *
 * Busy is user, nice, system, irq, softirq and steal; idle and iowait make up
 * the rest of the total. Guest time is already inside user.
 *
 * @param text - The file's content.
 * @param t - When it was read, in epoch milliseconds.
 */
export const parseProcStat = (text: string, t: number): HostReading | null => {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));

  if (!line) return null;

  const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);

  if (fields.length < 8 || !fields.every(Number.isFinite)) return null;

  const [
    user = 0,
    nice = 0,
    system = 0,
    idle = 0,
    iowait = 0,
    irq = 0,
    softirq = 0,
    steal = 0,
  ] = fields;
  const busy = user + nice + system + irq + softirq + steal;

  return { t, busy, total: busy + idle + iowait };
};

/**
 * Parses `/proc/<pid>/stat`, without its cgroup.
 *
 * The command name sits in parentheses and may itself hold spaces and
 * parentheses, so the fields are counted from the last `)`.
 *
 * @param text - The file's content.
 */
export const parseProcPidStat = (
  text: string,
): Omit<ProcReading, 'cgroup'> | null => {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');

  if (open === -1 || close < open) return null;

  // After the name: state, ppid, … utime is the 12th, stime the 13th and
  // starttime the 20th (fields 14, 15 and 22 of proc(5)).
  const fields = text
    .slice(close + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(text.slice(0, open));
  const ppid = Number(fields[1]);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const start = Number(fields[19]);

  if (![pid, ppid, ticks, start].every(Number.isFinite)) return null;

  return { pid, ppid, start, comm: text.slice(open + 1, close), ticks };
};

/** A container's processes, by cgroup: systemd driver, then cgroupfs. */
const CONTAINER_CGROUP =
  /docker-([0-9a-f]{64})\.scope|\/docker\/([0-9a-f]{64})/;

/** The Docker daemons, rootless or not. */
const DOCKER_CGROUP = /\/(?:docker|containerd)\.service$/;

/**
 * Maps container ID to name, from the readings `docker stats` gave.
 *
 * @param readings - Container readings.
 */
export const containerNames = (
  readings: readonly ContainerReading[],
): Map<string, string> =>
  new Map(readings.flatMap((r) => (r.id ? [[r.id, r.name] as const] : [])));

export interface OtherLoad {
  t: number;
  /** CPU used outside the stack, Docker and the runner, in cores. */
  cores: number;
}

/**
 * Measures the CPU used by everything that is neither the stack under test
 * nor the machinery running it, per interval between process snapshots.
 *
 * Attributed per process, as `top` does, rather than as host CPU minus the
 * stack's containers. The subtraction also counts what the rung itself
 * causes but no container is charged for (`docker compose run` creating the
 * k6 container, k6 compiling its script before `docker stats` lists it), and
 * that flagged idle hosts as busy.
 *
 * Left out: processes in a container of `project` (or one `docker stats` has
 * not named yet, such as a k6 container starting), the Docker daemons, and
 * the runner with everything it started. Another project's containers count.
 *
 * @param snapshots - Every process, once a second.
 * @param options - `project`; `runnerPid`; `clkTck` (`getconf CLK_TCK`);
 *   `names`, container ID to name, from `docker stats`.
 * @returns Per interval, the other cores; and per command, its CPU seconds.
 */
export const otherLoad = (
  snapshots: readonly ProcSnapshot[],
  options: {
    project: string;
    runnerPid: number;
    clkTck: number;
    names: ReadonlyMap<string, string>;
  },
): { series: OtherLoad[]; seconds: Map<string, number> } => {
  const { project, runnerPid, clkTck, names } = options;
  const series: OtherLoad[] = [];
  const seconds = new Map<string, number>();

  const counts = (proc: ProcReading, runner: ReadonlySet<number>): boolean => {
    if (runner.has(proc.pid) || DOCKER_CGROUP.test(proc.cgroup)) return false;

    const match = CONTAINER_CGROUP.exec(proc.cgroup);

    if (!match) return true;

    const name = names.get(match[1] ?? match[2] ?? '');

    return name !== undefined && !name.startsWith(`${project}-`);
  };

  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1];
    const next = snapshots[i];

    if (!prev || !next || next.t <= prev.t) continue;

    const before = new Map(
      prev.procs.map((p) => [`${String(p.pid)}:${String(p.start)}`, p.ticks]),
    );
    const children = new Map<number, number[]>();

    for (const proc of next.procs) {
      children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
    }

    const runner = new Set<number>();
    const queue = [runnerPid];

    for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
      runner.add(pid);
      queue.push(...(children.get(pid) ?? []));
    }

    let ticks = 0;

    for (const proc of next.procs) {
      if (!counts(proc, runner)) continue;

      // A process missing from the last snapshot began since, so all of its
      // CPU time falls in this interval.
      const delta =
        proc.ticks -
        (before.get(`${String(proc.pid)}:${String(proc.start)}`) ?? 0);

      if (delta <= 0) continue;

      ticks += delta;
      seconds.set(proc.comm, (seconds.get(proc.comm) ?? 0) + delta / clkTck);
    }

    series.push({
      t: next.t,
      cores: ticks / clkTck / ((next.t - prev.t) / 1000),
    });
  }

  return { series, seconds };
};

/**
 * Names the biggest users of other load, for the operator reading a busy
 * rung: "helium 0.41, zed-editor 0.14".
 *
 * @param seconds - CPU seconds per command, from {@link otherLoad}.
 * @param span - The rung's length in seconds.
 * @returns Up to three, each at least 0.05 cores on average; `null` if none.
 */
export const topOther = (
  seconds: ReadonlyMap<string, number>,
  span: number,
): string | null => {
  if (span <= 0) return null;

  const top = [...seconds]
    .map(([comm, cpu]) => [comm, cpu / span] as const)
    .filter(([, cores]) => cores >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  return top.length > 0
    ? top.map(([comm, cores]) => `${comm} ${cores.toFixed(2)}`).join(', ')
    : null;
};

/**
 * Parses the one-minute load average from `/proc/loadavg`.
 *
 * @param text - The file's content.
 */
export const parseLoadavg = (text: string): number | null => {
  const value = Number.parseFloat(text);

  return Number.isFinite(value) ? value : null;
};

/**
 * Counts active backends in `psql -At` output of `state|wait|count` rows.
 *
 * @param text - The query's output.
 */
export const parsePgActive = (text: string): number =>
  text
    .split('\n')
    .map((line) => line.split('|'))
    .filter(([state]) => state === 'active')
    .reduce((sum, [, , count]) => sum + (Number(count) || 0), 0);

/**
 * Nearest-rank percentile.
 *
 * @param values - Samples, in any order.
 * @param p - Percentile, 0 to 100.
 * @returns The value, or `null` for no samples.
 */
export const percentile = (
  values: readonly number[],
  p: number,
): number | null => {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));

  return sorted[rank - 1] ?? null;
};

const peak = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.max(...values);

/**
 * Reads the load-shedding start lines out of the app log.
 *
 * Matches the message exactly: the "Alert suppressed" line for the same event
 * carries the words "Load shedding started" in its title.
 *
 * @param lines - App log lines (pino JSON); others are ignored.
 */
export const shedStarts = (
  lines: readonly string[],
): Pick<
  SampleColumns,
  'shed_starts' | 'pool_waiting_at_start_max' | 'lag_at_start_max'
> => {
  const pool: number[] = [];
  const lag: number[] = [];

  for (const line of lines) {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (!isRecord(parsed) || parsed.msg !== 'Load shedding started') continue;

    pool.push(typeof parsed.poolWaiting === 'number' ? parsed.poolWaiting : 0);
    lag.push(typeof parsed.lagMs === 'number' ? parsed.lagMs : 0);
  }

  return {
    shed_starts: pool.length,
    pool_waiting_at_start_max: peak(pool),
    lag_at_start_max: peak(lag),
  };
};

/**
 * Reduces a rung's samples to its sample columns.
 *
 * Container CPU is in percent of one core, host CPU in percent of the whole
 * host, other load in cores (see {@link otherLoad}). Other load keeps its p95,
 * so a single busy second does not condemn a rung.
 *
 * @param samples - What the runner collected.
 * @param options - `project`, the compose project whose containers are the
 *   stack; `runnerPid` and `clkTck`, for {@link otherLoad}.
 */
export const summarizeSamples = (
  samples: SampleSet,
  options: { project: string; runnerPid: number; clkTck: number },
): SampleColumns => {
  const { project } = options;
  const cpuOf = (match: (name: string) => boolean) =>
    samples.containers.filter((r) => match(r.name)).map((r) => r.cpu);

  const app = cpuOf((name) => name === `${project}-app`);
  const hostPercent: number[] = [];

  for (let i = 1; i < samples.host.length; i++) {
    const prev = samples.host[i - 1];
    const next = samples.host[i];

    if (!prev || !next || next.total <= prev.total) continue;

    hostPercent.push(
      ((next.busy - prev.busy) / (next.total - prev.total)) * 100,
    );
  }

  const { series, seconds } = otherLoad(samples.procs, {
    ...options,
    names: containerNames(samples.containers),
  });
  const first = samples.procs.at(0);
  const last = samples.procs.at(-1);
  const span = first && last ? (last.t - first.t) / 1000 : 0;

  return {
    app_cpu_p95: percentile(app, 95),
    app_cpu_peak: peak(app),
    db_cpu_peak: peak(cpuOf((name) => name === `${project}-db`)),
    k6_cpu_peak: peak(cpuOf((name) => name.startsWith(`${project}-k6`))),
    host_cpu_peak: peak(hostPercent),
    other_load_p95: percentile(
      series.map((s) => s.cores),
      95,
    ),
    other_top: topOther(seconds, span),
    throttle_ms: samples.throttleMs
      ? samples.throttleMs.end - samples.throttleMs.start
      : null,
    load1_peak: peak(samples.load1),
    pg_active_peak: peak(samples.pgActive),
    ...shedStarts(samples.appLog),
  };
};
