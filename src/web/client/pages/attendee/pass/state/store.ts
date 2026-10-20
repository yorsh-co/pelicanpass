import type {
  AttendeeProfile,
  AttendeeRole,
} from '../../../../../../types/attendee.ts';

/**
 * The pass page's view of the attendee session, rendered into the page by
 * `web.routes` rather than fetched.
 */
export interface PassSessionView {
  attendeeId?: string | null;
  attendeeRole?: AttendeeRole | null;
}

/** The pass store's contents. Everything starts null: see the checkin store. */
export interface PassState {
  isSkeleton: boolean | null;
  session: Partial<PassSessionView> | null;
  profile: Partial<AttendeeProfile> | null;
}

let state: PassState = {
  isSkeleton: null,
  session: null,
  profile: null,
};

type Listener = (state: PassState) => void;

const listeners = new Set<Listener>();

const store = {
  getState: (): PassState => state,

  /** Merges a partial update into the state and notifies every subscriber. */
  setState: (partial: Partial<PassState>): void => {
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
