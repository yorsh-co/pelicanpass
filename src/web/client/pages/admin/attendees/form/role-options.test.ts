import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { rebuildRoleOptions } from './role-options.ts';

import type { RoleOptionsInput } from './role-options.ts';

const base: RoleOptionsInput = {
  options: ['burger', 'salad'],
  stored: '',
  renderedRole: 'participant',
  newRole: 'participant',
  previous: '',
  remembered: undefined,
};

const run = (over: Partial<RoleOptionsInput>) =>
  rebuildRoleOptions({ ...base, ...over });

describe('rebuildRoleOptions', () => {
  it('returns the role list as given', () => {
    assert.deepEqual(run({ options: ['pasta'] }).options, ['pasta']);
  });

  it('keeps a previous selection the new list contains', () => {
    const r = run({ newRole: 'volunteer', previous: 'salad' });

    assert.equal(r.selected, 'salad');
  });

  it('clears a previous selection the new list lacks', () => {
    const r = run({
      newRole: 'volunteer',
      options: ['pasta'],
      previous: 'burger',
    });

    assert.equal(r.selected, '');
  });

  it('restores what was chosen under the new role when the previous is gone', () => {
    const r = run({
      newRole: 'volunteer',
      options: ['pasta'],
      previous: 'burger',
      remembered: 'pasta',
    });

    assert.equal(r.selected, 'pasta');
  });

  it('restores a remembered choice over a blank previous selection', () => {
    assert.equal(run({ previous: '', remembered: 'salad' }).selected, 'salad');
  });

  it('ignores a remembered value the list no longer has', () => {
    assert.equal(run({ previous: '', remembered: 'gone' }).selected, '');
  });

  it('selects blank with nothing to keep or restore', () => {
    assert.equal(run({}).selected, '');
  });

  it('offers the stored off-list value under the rendered role', () => {
    const r = run({ stored: 'legacy', previous: 'legacy' });

    assert.equal(r.offList, 'legacy');
    assert.equal(r.selected, 'legacy');
  });

  it('does not offer the stored value under another role', () => {
    const r = run({
      stored: 'legacy',
      newRole: 'volunteer',
      previous: 'legacy',
    });

    assert.equal(r.offList, null);
    assert.equal(r.selected, '');
  });

  it('does not mark a stored value that is on the list as off-list', () => {
    assert.equal(run({ stored: 'burger' }).offList, null);
  });

  it('restores the off-list value when returning to the rendered role', () => {
    const r = run({ stored: 'legacy', previous: '', remembered: 'legacy' });

    assert.equal(r.selected, 'legacy');
  });

  it('offers no off-list value when none is stored', () => {
    assert.equal(run({ stored: '' }).offList, null);
  });
});
