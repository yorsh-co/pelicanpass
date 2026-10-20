import { logger } from '../log/logger.ts';

/**
 * Recovery for a Cloudflare challenge that arrived on a `fetch`.
 *
 * The zone is behind a domain-wide Managed Challenge. A visitor solves it once
 * on their first navigation and holds a `cf_clearance` cookie for the length of
 * the zone's Challenge Passage; when that lapses, the next request is
 * challenged again. On a navigation that is invisible — the interstitial
 * renders, the browser solves it, the page loads. On a `fetch` it is terminal:
 * the interstitial comes back as an HTML body the browser will never paint, the
 * origin never sees the request, and every subsequent call fails the same way.
 *
 * **Only a top-level navigation can clear it.** That is the whole of this
 * module: put something on screen that says so, and give it a button that
 * navigates.
 *
 * Reloading costs the attendee nothing. Flow state lives in the Redis session
 * rather than in the page, so every surface re-renders at the step it was on,
 * and the challenged request never reached the origin — there is no half-applied
 * write to worry about repeating.
 */

/** Attempts made in this tab, so a challenge that cannot be solved says so. */
const ATTEMPTS_KEY = 'cf-challenge-attempts';

/**
 * Attempts before the gate stops offering the button as the answer.
 *
 * A challenge is not always solvable — `docs/infrastructure/cloudflare-rules.md` records the
 * case, an attendee roaming on a foreign SIM presenting a non-BR country — and
 * the remedy there is the manual door, not a third identical tap.
 */
const MAX_ATTEMPTS = 2;

/**
 * Reads the attempt count.
 *
 * `sessionStorage` is not merely empty but *throws* in some webview privacy
 * modes, and this runs on the path that is already failing. A tab that cannot
 * count its attempts still gets a working button, which is the part that
 * matters.
 */
const readAttempts = (): number => {
  try {
    return Number(window.sessionStorage.getItem(ATTEMPTS_KEY)) || 0;
  } catch {
    return 0;
  }
};

/** Mirrors {@link readAttempts} so the happy path can skip the storage read. */
let attempts = readAttempts();

/** Whether the gate is already up. Raising it twice would stack prompts. */
let raised = false;

/** Set by {@link setChallengeRecovery}; a reload when nothing registered. */
let recover: (() => void) | undefined;

/**
 * Replaces the reload the gate's button performs.
 *
 * Registered rather than passed, because the gate is raised from the transport
 * layer (`core/api/api.request.ts`), which knows nothing about the page it is
 * running on. A page that needs a different recovery says so at startup.
 *
 * The only pages that need one are those rendered by a `POST`, where a reload
 * raises the browser's resubmission dialog —
 * `pages/admin/lookup/detail/index.ts` makes the argument in full. Everything
 * else leaves this unset and reloads.
 *
 * @param fn - What the button does instead. Must navigate: only a top-level
 *   navigation can render the interstitial and mint a fresh `cf_clearance`.
 */
export const setChallengeRecovery = (fn: () => void): void => {
  recover = fn;
};

/**
 * Forgets the attempt count after a request lands.
 *
 * Called on every successful response, so it returns before touching storage
 * unless there is actually something to clear: an attendee who recovered on
 * their second tap should not meet the volunteer copy the next time the
 * clearance lapses, hours later.
 */
export const noteRequestSucceeded = (): void => {
  if (attempts === 0) return;

  attempts = 0;

  try {
    window.sessionStorage.removeItem(ATTEMPTS_KEY);
  } catch {
    // Nothing to do: the count is already forgotten in memory, which is what
    // the next raise reads.
  }
};

/** Why the gate is going up, which decides its copy and its counting. */
type GateCause = 'challenge' | 'access';

/**
 * Covers the page with the challenge prompt.
 *
 * Idempotent, and deliberately so rather than by luck: `/staff` can have a poll
 * and a scan fail in the same tick, and the second must be a no-op rather than
 * a second overlay. That latch is also why the two causes share this module: on
 * the administrator surface an expired Access session and a challenged `fetch`
 * are the same lapse of edge state, so a second panel with its own flag would
 * stack two modal covers at the same z-index and fight over the focus call.
 *
 * Raising the gate does not swallow the error — {@link request} still throws,
 * so callers are unchanged and their own error handling runs underneath a cover
 * nobody can read. That is the point of covering the viewport: a step that has
 * already rendered "código inválido" against a request the server never saw
 * would otherwise be the only thing on screen.
 *
 * @param options - `cause` defaults to `'challenge'`, which is the attendee
 *   surface's only case and must keep behaving exactly as it did.
 */
export const raiseChallengeGate = (
  options: { cause?: GateCause } = {},
): void => {
  const { cause = 'challenge' } = options;

  if (raised) return;

  const gate = document.querySelector<HTMLElement>('[data-main="challenge"]');

  if (!gate) {
    // Every layout that makes requests carries the partial: `layouts/main`,
    // `layouts/admin`, and `pages/admin/login` on `layouts/plain` — that page
    // includes it itself, because the landing and error pages share the layout
    // and must not gain a gate. Reaching here means a fourth one started to.
    logger.error('challenge', 'no gate on this layout');

    return;
  }

  raised = true;

  // The counter belongs to the challenge case alone. It exists for a challenge
  // that cannot be solved — the roaming-SIM case `docs/infrastructure/cloudflare-rules.md`
  // records — and its second state tells the reader to fetch somebody. An Access
  // session that lapsed twice is not that: it is two ordinary sign-ins, and
  // advising a volunteer to go and find a coordinator would be wrong.
  const exhausted = cause === 'challenge' && attempts >= MAX_ATTEMPTS;

  const variant =
    cause === 'access' ? 'expired-access' : exhausted ? 'blocked' : 'expired';

  const message = gate.querySelector<HTMLElement>(
    `[data-challenge="${variant}"]`,
  );

  if (message) message.hidden = false;

  const button = gate.querySelector<HTMLButtonElement>(
    '[data-challenge="continue"]',
  );

  if (button) {
    // Every label is carried on the element so the wording stays with the rest
    // of the gate's copy in the partial — the module has no catalog of its own,
    // and no admin route inlines `chrome`.
    const label =
      cause === 'access'
        ? button.dataset.labelReauth
        : exhausted
          ? button.dataset.labelBlocked
          : button.dataset.labelExpired;

    button.textContent = label ?? '';

    button.onclick = () => {
      button.disabled = true;

      // Written before navigating rather than after: the read that consumes it
      // happens in the *next* document, and a tap that never comes back is
      // exactly the tap worth counting.
      //
      // The in-memory mirror is advanced with it. Nothing in this document
      // reads it again — the navigation below is unconditional — but leaving
      // the two disagreeing makes the guard in `noteRequestSucceeded` quietly
      // wrong for any caller that does.
      //
      // Not counted for the Access cause, for the reason given above: the tap
      // that follows is a sign-in, not a re-attempt at something unsolvable.
      if (cause === 'challenge') {
        attempts += 1;

        try {
          window.sessionStorage.setItem(ATTEMPTS_KEY, String(attempts));
        } catch {
          // An uncounted attempt only costs the volunteer copy on a later raise.
        }
      }

      if (recover) recover();
      else window.location.reload();
    };
  }

  logger.warn('challenge', 'edge challenge gate raised', { attempts });

  gate.hidden = false;

  // Deferred a frame so the transition has a painted `hidden = false` state to
  // run from; set in the same frame, the element goes straight to its end
  // state. Same reason `bootScreen` does it.
  requestAnimationFrame(() => {
    gate.classList.add('show');
  });

  if (button) button.focus();
};
