import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildQrUrls } from './urls.ts';
import { qrService } from '../../src/modules/qr/qr.service.ts';

const qrToken = 'abcDEF1234';

describe('buildQrUrls', () => {
  it('builds both poster URLs', () => {
    assert.deepEqual(buildQrUrls({ appUrl: 'https://example.com', qrToken }), {
      participant: 'https://example.com/checkin?k=abcDEF1234',
      volunteer: 'https://example.com/checkin?audience=volunteer&k=abcDEF1234',
    });
  });

  it('accepts an APP_URL with a trailing slash', () => {
    const urls = buildQrUrls({ appUrl: 'https://example.com/', qrToken });

    assert.equal(urls.participant, 'https://example.com/checkin?k=abcDEF1234');
  });

  it('produces URLs the scanner reads the token back from', () => {
    const urls = buildQrUrls({ appUrl: 'https://example.com', qrToken });

    assert.equal(qrService.extractToken(urls.participant), qrToken);
    assert.equal(qrService.extractToken(urls.volunteer), qrToken);
  });

  it('rejects a token the door would reject', () => {
    for (const bad of ['short', 'a'.repeat(33), 'abcdef-1234', 'abcdef1234=']) {
      assert.throws(
        () => buildQrUrls({ appUrl: 'https://example.com', qrToken: bad }),
        /CHECKIN_QR_TOKEN/,
      );
    }
  });

  it('rejects an APP_URL that is not a bare http(s) origin', () => {
    for (const bad of [
      'example.com',
      'ftp://example.com',
      'https://example.com/app',
      'https://example.com/?x=1',
      'https://example.com/#top',
    ]) {
      assert.throws(() => buildQrUrls({ appUrl: bad, qrToken }), /APP_URL/);
    }
  });
});
