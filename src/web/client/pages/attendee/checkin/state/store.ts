import type { CheckinState } from '../types.ts';

let state: CheckinState = {
  currentUiStepKey: null,
  captchaRequired: null,
  isSkeleton: null,
  session: null,
  audienceHint: null,
};

type Listener = (state: CheckinState) => void;

const listeners = new Set<Listener>();

const store = {
  getState: (): CheckinState => state,

  /** Merges a partial update into the state and notifies every subscriber. */
  setState: (partial: Partial<CheckinState>): void => {
    state = { ...state, ...partial };

    listeners.forEach((fn) => {
      fn(state);
    });
  },

  /** @returns Teardown that removes the subscriber. */
  subscribe: (fn: Listener): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export default store;
