import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { doorTemplateProblem } from './whatsapp.door-template.ts';

describe('doorTemplateProblem', () => {
  it('refuses a key the registry does not hold', () => {
    assert.match(
      doorTemplateProblem('no_such_template', 'participant') ?? '',
      /names no entry/,
    );
    assert.match(doorTemplateProblem('', 'volunteer') ?? '', /names no entry/);
  });

  it('accepts a registry key offered to participants', () => {
    assert.equal(doorTemplateProblem('pax_door_v1:pt_BR', 'participant'), null);
  });

  it('accepts a registry key offered to volunteers', () => {
    assert.equal(doorTemplateProblem('vol_door_v1:pt_BR', 'volunteer'), null);
  });

  it('refuses a registry key not offered to the role', () => {
    assert.match(
      doorTemplateProblem('pax_door_v1:pt_BR', 'volunteer') ?? '',
      /is not offered to the volunteer role/,
    );
  });
});
