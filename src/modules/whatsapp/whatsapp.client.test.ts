import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  WHATSAPP_TEMPLATES,
  type TemplateAttendeeRow,
  type WhatsappTemplate,
} from '../../constants/whatsapp-templates.ts';
import { buildTemplatePayload } from './whatsapp.client.ts';

const row: TemplateAttendeeRow = {
  attendee_name: 'Ana Souza',
  ticket_code: 'abc123',
  ticket_link_token: 'token',
  team: null,
  checkin_time: null,
  lunch_option: null,
};

describe('buildTemplatePayload language', () => {
  it('sends the registry entry’s approved language code', () => {
    for (const template of Object.values<WhatsappTemplate>(
      WHATSAPP_TEMPLATES,
    )) {
      const { template: sent } = buildTemplatePayload(
        template,
        '5511999999999',
        row,
      );

      assert.equal(sent.language.code, template.language, template.name);
    }
  });
});
