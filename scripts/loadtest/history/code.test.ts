import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appTreeHash, HARNESS_PATHS } from './code.ts';

const TREE = [
  '100644 blob 1111111111111111111111111111111111111111\tDockerfile',
  '040000 tree 2222222222222222222222222222222222222222\tsrc',
].join('\n');

describe('appTreeHash', () => {
  it('is stable for the same tree', () => {
    assert.equal(appTreeHash(TREE, ''), appTreeHash(TREE, ''));
    assert.match(appTreeHash(TREE, ''), /^[0-9a-f]{40}$/);
  });

  it('changes with the app', () => {
    const changed = TREE.replace('2222', '3333');

    assert.notEqual(appTreeHash(changed, ''), appTreeHash(TREE, ''));
  });

  it('tells an uncommitted change from a clean tree, and from another change', () => {
    const clean = appTreeHash(TREE, '');
    const one = appTreeHash(TREE, '+const SAMPLES_TO_STOP = 10;');
    const other = appTreeHash(TREE, '+const SAMPLES_TO_STOP = 6;');

    assert.notEqual(one, clean);
    assert.notEqual(one, other);
    assert.equal(one, appTreeHash(TREE, '+const SAMPLES_TO_STOP = 10;'));
  });

  it('does not confuse the tree with the diff', () => {
    assert.notEqual(appTreeHash('ab', ''), appTreeHash('a', 'b'));
  });
});

describe('HARNESS_PATHS', () => {
  it('covers only the scenarios, not what the runner writes', () => {
    for (const path of HARNESS_PATHS) {
      assert.match(path, /^loadtest\//);
      assert.doesNotMatch(path, /^loadtest\/(history|results)(\/|$)/);
      assert.notEqual(path, 'loadtest/fixtures.json');
    }
  });
});
