import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { metricsLabels } from './metrics.labels.ts';
import { getMessages } from '../../i18n/catalogs.ts';

const labels = metricsLabels(getMessages('pt-BR', 'admin-metrics'));

describe('metricsLabels.checkinPrefix', () => {
  it('marks the walk-in key as the door', () => {
    assert.equal(labels.checkinPrefix('d'), 'd (porta)');
  });

  it('shows any other key as is', () => {
    for (const key of ['x', '7', 'v']) {
      assert.equal(labels.checkinPrefix(key), key);
    }
  });
});
