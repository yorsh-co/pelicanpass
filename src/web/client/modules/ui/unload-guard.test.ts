import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { createUnloadGuard, stopLeaving } from './unload-guard.ts';

import type { UnloadGuard } from './unload-guard.ts';

describe('createUnloadGuard', () => {
  let target: EventTarget;
  let guard: UnloadGuard;

  /** Dispatches `beforeunload` and reports whether leaving was challenged. */
  const unload = (): boolean => {
    const event = new Event('beforeunload', { cancelable: true });

    target.dispatchEvent(event);

    return event.defaultPrevented;
  };

  beforeEach(() => {
    target = new EventTarget();
    guard = createUnloadGuard(target);
  });

  it('lets the page go while not held', () => {
    assert.equal(unload(), false);
  });

  it('asks before leaving while held', () => {
    guard.hold();

    assert.equal(unload(), true);
  });

  it('lets the page go once released', () => {
    guard.hold();
    guard.release();

    assert.equal(unload(), false);
  });

  it('keeps a single listener across repeated holds', () => {
    guard.hold();
    guard.hold();
    guard.release();

    assert.equal(unload(), false);
  });
});

describe('stopLeaving', () => {
  const scope = globalThis as { Element?: unknown };
  const hadElement = scope.Element !== undefined;
  const original = scope.Element;

  const SUBMIT = 'button[type="submit"], input[type="submit"]';

  /** Just enough of `Element` for `leavesPage`: `closest` answers from a map. */
  class StubElement extends EventTarget {
    readonly matches: Record<string, unknown>;

    constructor(matches: Record<string, unknown> = {}) {
      super();
      this.matches = matches;
    }

    closest(selector: string): unknown {
      return this.matches[selector] ?? null;
    }
  }

  /** A submit button inside a form that does or does not carry an `action`. */
  const submitButton = (action: boolean): StubElement =>
    new StubElement({
      [SUBMIT]: { form: { hasAttribute: () => action } },
    });

  // Node has no `Element`, which `leavesPage` tests with `instanceof`.
  before(() => {
    scope.Element = StubElement;
  });

  after(() => {
    if (hadElement) scope.Element = original;
    else delete scope.Element;
  });

  /** A click as `stopLeaving` reads it, recording whether it was cancelled. */
  const click = (
    init: Partial<Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>> & {
      target?: EventTarget | null;
    },
  ) => {
    const event = {
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      target: null,
      defaultPrevented: false,
      preventDefault: () => {
        event.defaultPrevented = true;
      },
      ...init,
    };

    return event;
  };

  for (const key of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
    it(`leaves a ${key} click alone`, () => {
      const event = click({ [key]: true });

      assert.equal(stopLeaving(event), false);
      assert.equal(event.defaultPrevented, false);
    });
  }

  it('leaves a click on a non-element alone', () => {
    const event = click({ target: new EventTarget() });

    assert.equal(stopLeaving(event), false);
    assert.equal(event.defaultPrevented, false);
  });

  it('cancels a click on a link', () => {
    const event = click({ target: new StubElement({ 'a[href]': {} }) });

    assert.equal(stopLeaving(event), true);
    assert.equal(event.defaultPrevented, true);
  });

  it('leaves a click on a plain element alone', () => {
    const event = click({ target: new StubElement() });

    assert.equal(stopLeaving(event), false);
    assert.equal(event.defaultPrevented, false);
  });

  it('cancels a submit that the browser posts', () => {
    const event = click({ target: submitButton(true) });

    assert.equal(stopLeaving(event), true);
    assert.equal(event.defaultPrevented, true);
  });

  it('leaves a submit handled by script alone', () => {
    const event = click({ target: submitButton(false) });

    assert.equal(stopLeaving(event), false);
    assert.equal(event.defaultPrevented, false);
  });
});
