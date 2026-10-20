import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isWhatsappTemplateKey } from '../../src/constants/whatsapp-templates.ts';
import { DEFAULT_TEMPLATE } from './defaults.ts';

describe('send-test defaults', () => {
  it('names a template the sender knows', () => {
    assert.ok(isWhatsappTemplateKey(DEFAULT_TEMPLATE), DEFAULT_TEMPLATE);
  });
});
