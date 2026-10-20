import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isWsl,
  parseCpuinfo,
  parseCpuList,
  parseMeminfo,
  sameCpus,
} from './host.ts';

describe('parseCpuinfo', () => {
  it('reads the model and counts logical CPUs', () => {
    const text = [
      'processor\t: 0',
      'model name\t: 12th Gen Intel(R) Core(TM) i7-1260P',
      '',
      'processor\t: 1',
      'model name\t: 12th Gen Intel(R) Core(TM) i7-1260P',
      '',
    ].join('\n');

    assert.deepEqual(parseCpuinfo(text), {
      cpuModel: '12th Gen Intel(R) Core(TM) i7-1260P',
      cores: 2,
    });
  });

  it('leaves the model empty where the kernel does not report one', () => {
    assert.deepEqual(parseCpuinfo('processor\t: 0\n'), {
      cpuModel: null,
      cores: 1,
    });
  });
});

describe('parseMeminfo', () => {
  it('reads total memory in GiB', () => {
    assert.equal(
      parseMeminfo('MemTotal:       15982736 kB\nMemFree: 1 kB\n'),
      15.2,
    );
    assert.equal(parseMeminfo('MemFree: 1 kB\n'), null);
  });
});

describe('isWsl', () => {
  it("recognises WSL2's kernel", () => {
    assert.equal(isWsl('5.15.153.1-microsoft-standard-WSL2'), true);
    assert.equal(isWsl('7.0.0-34-generic'), false);
  });
});

describe('parseCpuList', () => {
  it('reads ranges and single CPUs', () => {
    assert.deepEqual(
      [...(parseCpuList('0-3,8,10-11') ?? [])],
      [0, 1, 2, 3, 8, 10, 11],
    );
    assert.deepEqual([...(parseCpuList('5\n') ?? [])], [5]);
  });

  it('refuses what is not a CPU list', () => {
    assert.equal(parseCpuList(''), null);
    assert.equal(parseCpuList('0-'), null);
    assert.equal(parseCpuList('3-1'), null);
    assert.equal(parseCpuList('performance'), null);
  });
});

describe('sameCpus', () => {
  it('compares CPUs, not spelling', () => {
    assert.equal(sameCpus('0-3', '0,1,2,3'), true);
    assert.equal(sameCpus('0-7', '0-15'), false);
    assert.equal(sameCpus('0-7', 'x'), false);
  });
});
