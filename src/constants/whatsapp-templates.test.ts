import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  TEMPLATE_RESOLVERS,
  VOLUNTEER_ONLY_VARIABLES,
  WHATSAPP_TEMPLATES,
  type TemplateAttendeeRow,
  type WhatsappTemplate,
} from './whatsapp-templates.ts';

const row = (overrides: Partial<TemplateAttendeeRow> = {}) => ({
  attendee_name: 'Ana Souza',
  ticket_code: 'vabc12',
  ticket_link_token: 'token',
  team: null,
  checkin_time: null,
  lunch_option: null,
  ...overrides,
});

describe('TEMPLATE_RESOLVERS.team', () => {
  it('returns the stored value', () => {
    assert.equal(TEMPLATE_RESOLVERS.team(row({ team: 'Louvor' })), 'Louvor');
  });

  it('falls back when unset', () => {
    assert.equal(TEMPLATE_RESOLVERS.team(row()), 'a definir');
  });
});

describe('TEMPLATE_RESOLVERS.checkinTime', () => {
  it('writes a whole hour without minutes or a leading zero', () => {
    assert.equal(
      TEMPLATE_RESOLVERS.checkinTime(row({ checkin_time: '07:00:00' })),
      '7h',
    );
    assert.equal(
      TEMPLATE_RESOLVERS.checkinTime(row({ checkin_time: '00:00:00' })),
      '0h',
    );
  });

  it('writes minutes after the hour otherwise', () => {
    assert.equal(
      TEMPLATE_RESOLVERS.checkinTime(row({ checkin_time: '08:30:00' })),
      '8h30',
    );
    assert.equal(
      TEMPLATE_RESOLVERS.checkinTime(row({ checkin_time: '13:05:00' })),
      '13h05',
    );
  });

  it('falls back when unset', () => {
    assert.equal(TEMPLATE_RESOLVERS.checkinTime(row()), 'a definir');
  });
});

describe('TEMPLATE_RESOLVERS.lunchOption', () => {
  it('prefixes the stored label', () => {
    assert.equal(
      TEMPLATE_RESOLVERS.lunchOption(row({ lunch_option: '11h30' })),
      '🍴 Almoço: 11h30',
    );
    assert.equal(
      TEMPLATE_RESOLVERS.lunchOption(row({ lunch_option: '11h (brunch)' })),
      '🍴 Almoço: 11h (brunch)',
    );
  });

  it('is a bare hyphen when the volunteer has no lunch', () => {
    assert.equal(TEMPLATE_RESOLVERS.lunchOption(row()), '-');
  });
});

describe('WHATSAPP_TEMPLATES', () => {
  it('offers a template using a volunteer-only variable to volunteers only', () => {
    for (const [key, template] of Object.entries<WhatsappTemplate>(
      WHATSAPP_TEMPLATES,
    )) {
      const variables = [
        ...template.body,
        ...(template.urlButton ? [template.urlButton.variable] : []),
      ];

      if (
        variables.some((variable) => VOLUNTEER_ONLY_VARIABLES.has(variable))
      ) {
        assert.deepEqual(template.roles, ['volunteer'], key);
      }
    }
  });
});

describe('WHATSAPP_TEMPLATES checkedInOnly', () => {
  it('is set on exactly the two feedback templates', () => {
    const surveys = ['pax_survey_v1:pt_BR', 'vol_survey_v1:pt_BR'];

    for (const [key, template] of Object.entries<WhatsappTemplate>(
      WHATSAPP_TEMPLATES,
    )) {
      assert.equal(template.checkedInOnly, surveys.includes(key), key);
    }
  });
});
