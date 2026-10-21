import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyForm } from './admin-guard.ts';

import type { FormVerdict } from './admin-guard.ts';

/** Classifies a form with no `id`, as most of them are. */
const verdict = (path: string, method = 'post', id = ''): FormVerdict =>
  classifyForm({ path, method, id });

describe('classifyForm', () => {
  it('opens a record from the lookup forms with a GET to the same path', () => {
    for (const path of [
      '/admin/lookup/record',
      '/admin/redemptions/record',
      '/admin/tshirts/record',
      '/admin/volunteers/record',
    ]) {
      assert.deepEqual(verdict(path), { kind: 'navigate', to: path });
    }
  });

  it('ignores the method case and a trailing slash', () => {
    assert.deepEqual(verdict('/admin/lookup/record/', 'POST'), {
      kind: 'navigate',
      to: '/admin/lookup/record',
    });
  });

  it('refuses mutations with the changes-disabled notice', () => {
    for (const path of ['/admin/whatsapp', '/admin/attendees', '/admin']) {
      assert.deepEqual(verdict(path), { kind: 'refuse', notice: 'disabled' });
    }

    assert.deepEqual(verdict('/admin/survey', 'PATCH'), {
      kind: 'refuse',
      notice: 'disabled',
    });
  });

  it('refuses searches and record pages the demo does not ship as unavailable', () => {
    for (const path of [
      '/admin/tshirts',
      '/admin/lookup',
      '/admin/attendees',
    ]) {
      assert.deepEqual(verdict(path, 'post', 'filters'), {
        kind: 'refuse',
        notice: 'unavailable',
      });
    }

    for (const path of ['/admin/attendees/new', '/admin/attendees/edit']) {
      assert.deepEqual(verdict(path), {
        kind: 'refuse',
        notice: 'unavailable',
      });
    }
  });

  it('leaves GET and dialog forms to the page', () => {
    assert.deepEqual(verdict('/admin/survey', 'get'), { kind: 'ignore' });
    assert.deepEqual(verdict('/admin/survey', 'GET'), { kind: 'ignore' });
    assert.deepEqual(verdict('/admin/survey', 'dialog'), { kind: 'ignore' });
  });

  it('leaves forms outside the administrator area to the mock API', () => {
    for (const path of ['/checkin', '/administrator', '/api/v1/admin/x']) {
      assert.deepEqual(verdict(path), { kind: 'ignore' });
    }
  });
});
