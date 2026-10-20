/**
 * The host facts recorded with every rung, parsed from `/proc` so the runner
 * only reads files.
 */

/**
 * Reads the CPU model and logical CPU count from `/proc/cpuinfo`.
 *
 * @param text - The file's content.
 */
export const parseCpuinfo = (
  text: string,
): { cpuModel: string | null; cores: number } => {
  const lines = text.split('\n');
  const model = lines.find((line) => line.startsWith('model name'));

  return {
    cpuModel: model?.split(':').slice(1).join(':').trim() ?? null,
    cores: lines.filter((line) => /^processor\s*:/.test(line)).length,
  };
};

/**
 * Reads total memory from `/proc/meminfo`, in GiB to one decimal.
 *
 * @param text - The file's content.
 */
export const parseMeminfo = (text: string): number | null => {
  const match = /^MemTotal:\s+(\d+)\s+kB/m.exec(text);

  return match?.[1]
    ? Math.round((Number(match[1]) / 1024 ** 2) * 10) / 10
    : null;
};

/**
 * Whether the kernel is WSL2's. Its release string names Microsoft, as in
 * `5.15.153.1-microsoft-standard-WSL2`.
 *
 * @param release - `uname -r`, or `/proc/sys/kernel/osrelease`.
 */
export const isWsl = (release: string): boolean => /microsoft/i.test(release);

/**
 * Parses a kernel CPU list, as in `Cpus_allowed_list` or `--cpuset-cpus`:
 * `0-3,8,10-11`.
 *
 * @param list - The list.
 * @returns The CPUs, or `null` if it is not a CPU list.
 */
export const parseCpuList = (list: string): Set<number> | null => {
  const cpus = new Set<number>();

  for (const part of list.trim().split(',')) {
    const bounds = part.split('-');

    if (bounds.length > 2 || !bounds.every((b) => /^\d+$/.test(b))) {
      return null;
    }

    const from = Number(bounds[0]);
    const to = Number(bounds[1] ?? bounds[0]);

    if (to < from) return null;

    for (let cpu = from; cpu <= to; cpu++) cpus.add(cpu);
  }

  return cpus;
};

/**
 * Whether two CPU lists name the same CPUs, however they are written.
 *
 * @param a - A CPU list.
 * @param b - Another.
 */
export const sameCpus = (a: string, b: string): boolean => {
  const left = parseCpuList(a);
  const right = parseCpuList(b);

  return (
    left !== null &&
    right !== null &&
    left.size === right.size &&
    [...left].every((cpu) => right.has(cpu))
  );
};
