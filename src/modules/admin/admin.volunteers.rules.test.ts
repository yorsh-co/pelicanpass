import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readVolunteerPermissions } from './admin.volunteers.rules.ts';
import { ValidationError } from '../../shared/errors/app-error.ts';

const valid = {
  canRedeem: true,
  redeemScopes: ['lunch', 'meal'],
  canDraw: false,
  showAdminLink: true,
  team: 'Kitchen',
  teamRole: 'Lead',
  checkinTime: '08:30',
};

const refused = (body: unknown): void => {
  assert.throws(
    () => readVolunteerPermissions(body),
    (err) => err instanceof ValidationError && err.statusCode === 400,
  );
};

describe('readVolunteerPermissions', () => {
  it('reads a complete body', () => {
    assert.deepEqual(readVolunteerPermissions(valid), valid);
  });

  it('ignores unknown keys', () => {
    assert.deepEqual(
      readVolunteerPermissions({ ...valid, adminUsername: 'x' }),
      valid,
    );
  });

  it('refuses a body that is not an object', () => {
    for (const body of [undefined, null, 'x', 1, []]) refused(body);
  });

  it('refuses a flag that is absent or not a boolean', () => {
    for (const field of ['canRedeem', 'canDraw', 'showAdminLink']) {
      refused({ ...valid, [field]: undefined });

      for (const value of ['true', 1, 0, null]) {
        refused({ ...valid, [field]: value });
      }
    }
  });

  it('refuses stations that are not an array of known items', () => {
    refused({ ...valid, redeemScopes: undefined });
    refused({ ...valid, redeemScopes: 'lunch' });
    refused({ ...valid, redeemScopes: ['lunch', 'sandwich'] });
    refused({ ...valid, redeemScopes: ['lunch', 1] });
    refused({ ...valid, redeemScopes: ['toString'] });
  });

  it('de-duplicates stations and returns them in item order', () => {
    const { redeemScopes } = readVolunteerPermissions({
      ...valid,
      redeemScopes: ['drink', 'lunch', 'drink', 'tshirt_volunteer'],
    });

    assert.deepEqual(redeemScopes, ['tshirt_volunteer', 'lunch', 'drink']);
  });

  it('allows canRedeem with no stations', () => {
    const result = readVolunteerPermissions({ ...valid, redeemScopes: [] });

    assert.equal(result.canRedeem, true);
    assert.deepEqual(result.redeemScopes, []);
  });

  it('reads a check-in time as HH:MM, padding a single-digit hour', () => {
    for (const [given, stored] of [
      ['08:30', '08:30'],
      ['8:30', '08:30'],
      [' 23:59 ', '23:59'],
      ['00:00', '00:00'],
    ]) {
      assert.equal(
        readVolunteerPermissions({ ...valid, checkinTime: given }).checkinTime,
        stored,
      );
    }
  });

  it('turns a blank or null check-in time into null', () => {
    for (const checkinTime of ['', '  ', null]) {
      assert.equal(
        readVolunteerPermissions({ ...valid, checkinTime }).checkinTime,
        null,
      );
    }
  });

  it('refuses a check-in time that is absent, not a string or not a time', () => {
    refused({ ...valid, checkinTime: undefined });

    for (const checkinTime of [
      830,
      true,
      '24:00',
      '8:5',
      '08:60',
      '08:30:00',
      '8h30',
      '8',
      'noon',
    ]) {
      refused({ ...valid, checkinTime });
    }
  });

  it('trims labels and turns blank into null', () => {
    const result = readVolunteerPermissions({
      ...valid,
      team: '  Bar  ',
      teamRole: ' \t\n',
    });

    assert.equal(result.team, 'Bar');
    assert.equal(result.teamRole, null);
  });

  it('reads null labels as null', () => {
    const result = readVolunteerPermissions({
      ...valid,
      team: null,
      teamRole: null,
    });

    assert.equal(result.team, null);
    assert.equal(result.teamRole, null);
  });

  it('refuses a label that is absent or not a string', () => {
    refused({ ...valid, team: undefined });
    refused({ ...valid, teamRole: 5 });
  });

  it('accepts 40 characters and refuses 41', () => {
    assert.equal(
      readVolunteerPermissions({ ...valid, team: 'a'.repeat(40) }).team,
      'a'.repeat(40),
    );

    refused({ ...valid, team: 'a'.repeat(41) });
    refused({ ...valid, teamRole: 'a'.repeat(41) });
  });

  it('counts a multi-byte character once, as the database does', () => {
    const forty = `${'a'.repeat(39)}😀`;

    assert.equal(forty.length, 41);
    assert.equal(
      readVolunteerPermissions({ ...valid, team: forty }).team,
      forty,
    );

    refused({ ...valid, team: `${forty}a` });
  });

  it('names no input in its message', () => {
    assert.throws(
      () => readVolunteerPermissions({ ...valid, team: 'x'.repeat(41) }),
      (err) => err instanceof Error && !err.message.includes('xxx'),
    );
  });
});
