/** Holds the browser's leave-page prompt while an action waits for its confirm. */
export interface UnloadGuard {
  /** Asks the browser to confirm before the page is left. Idempotent. */
  hold: () => void;

  /** Lets the page be left without asking. Idempotent. */
  release: () => void;
}

/**
 * Builds the leave-page prompt for an arm-then-confirm control.
 *
 * The `beforeunload` listener exists only while held: a permanent one keeps
 * some browsers from putting the page in the back/forward cache. Browsers show
 * their own localised text and ignore any message set here. iOS never shows
 * the prompt at all.
 *
 * @param target - Where `beforeunload` is dispatched; `window` outside tests.
 * @returns The guard.
 */
export const createUnloadGuard = (
  target: EventTarget = window,
): UnloadGuard => {
  const onBeforeUnload = (event: Event): void => {
    event.preventDefault();
  };

  let held = false;

  return {
    hold: () => {
      if (held) return;

      held = true;
      target.addEventListener('beforeunload', onBeforeUnload);
    },
    release: () => {
      if (!held) return;

      held = false;
      target.removeEventListener('beforeunload', onBeforeUnload);
    },
  };
};

/**
 * Whether a click navigates away from the page: a link, or the submit button
 * of a form the browser posts itself.
 *
 * Use {@link stopLeaving} to act on it. A form without an `action` is
 * submitted by script and does not count.
 *
 * @param target - The click's target.
 */
export const leavesPage = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;

  if (target.closest('a[href]')) return true;

  const submitter = target.closest<HTMLButtonElement | HTMLInputElement>(
    'button[type="submit"], input[type="submit"]',
  );

  return submitter?.form?.hasAttribute('action') ?? false;
};

/**
 * Cancels a click that would leave the page while a control is armed.
 *
 * `beforeunload` is not enough: iOS never shows its prompt, so a tap on a link
 * would drop the pending action silently. The caller disarms the control and
 * tells the operator; the next click leaves normally. A modified click opens
 * a new tab or window and keeps this page, so it is left alone.
 *
 * @param event - The document-level click.
 * @returns Whether the click was cancelled.
 */
export const stopLeaving = (
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'target'> &
    Pick<Event, 'preventDefault'>,
): boolean => {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return false;

  if (!leavesPage(event.target)) return false;

  event.preventDefault();

  return true;
};
