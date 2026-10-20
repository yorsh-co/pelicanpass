/**
 * How long the check-in flow deliberately waits.
 *
 * These were fifteen `1000`s scattered across four step modules, the boot
 * screen and the skeleton helper. A happy-path check-in spent **over four
 * seconds** in enforced animation on top of whatever the network cost — per
 * attendee, through a queue of hundreds. At the door that is not polish, it is
 * throughput, and it reads as a slow app rather than a considered one.
 *
 * They are still non-zero on purpose. A request that resolves in 80 ms and
 * flashes three states past the attendee is worse than one that holds each
 * state long enough to be read; the floor is what makes the flow legible, not
 * what makes it feel expensive.
 *
 * Every value is a floor measured from the start of the operation, so a slow
 * network adds nothing on top — the wait and the work overlap.
 */

/** Floor for a request's "processing" state before its result may show. */
export const MIN_PROCESSING_MS = 800;

/** How long a success message rests before the flow advances to the next step. */
export const SUCCESS_DWELL_MS = 800;

/**
 * How long the volunteer-confirmation button stays disabled after staff had
 * not confirmed the attendee yet.
 *
 * Every such answer counts toward the QR step's attempt limit, shared with
 * scans. Pacing an honest attendee keeps taps made before the volunteer has
 * finished from spending the budget a real lockout is meant to protect.
 */
export const PRESENCE_RETRY_COOLDOWN_MS = 5_000;

/** Floor for a skeleton, so a fast load does not flicker one frame of grey. */
export const MIN_SKELETON_MS = 400;

/** Floor for the boot screen. */
export const BOOT_MIN_MS = 1000;

/**
 * The success step's own two beats: the confirmation, then the hand-off to the
 * pass. Longer than a step transition because this one is the payoff and is
 * read rather than passed through.
 */
export const SUCCESS_CONFIRM_MS = 1500;
export const SUCCESS_HANDOFF_MS = 1500;

/**
 * How long the raffle number rolls before it settles.
 *
 * The longest deliberate wait in the application, and the only one that is not
 * a floor: it is the animation itself rather than a minimum imposed on one.
 * Long enough to build to something in a room watching a projector, short
 * enough to call two hundred numbers without the evening becoming the wait.
 */
export const RAFFLE_ROLL_MS = 2500;

/**
 * How long a band may sit expired before its screen offers a refresh.
 *
 * The next band is deliberately requested 400 ms past the boundary and then has
 * a round trip to make, so every window ends with a short gap in which the
 * displayed band is expired and its replacement is already on the way. Covering
 * that gap is what stops both screens flashing a refresh button twice a minute.
 *
 * Comfortably past a slow round trip, comfortably short of the 5 s backoff, so
 * a genuine failure still surfaces the button before the loop's own next try.
 */
export const BAND_GRACE_MS = 3000;

/**
 * How far past a window boundary the next band is asked for.
 *
 * A refresh landing exactly on the boundary races the server's own view of
 * which window it is in. A small lag costs nothing — a token stays valid for a
 * second window — and removes the race.
 */
export const BAND_LAG_MS = 400;

/**
 * Backoff after a failed band refresh, so a dead API is not polled every second.
 *
 * Also how long a retry button stays disabled: while an attempt is about to
 * fire by itself, a second tap has nothing to offer.
 */
export const BAND_RETRY_MS = 5_000;

/**
 * How far past its floor a failed refresh may be retried, as a fraction of it.
 *
 * Shedding refuses a whole room in the same second, and every phone it refused
 * would otherwise retry in the same second, just after shedding stops, and trip
 * it again. Spreading the retries over half the backoff again breaks that up.
 */
const RETRY_JITTER = 0.5;

/**
 * Delay before retrying a failed band refresh.
 *
 * At least {@link BAND_RETRY_MS}, raised to the server's `Retry-After` when it
 * asks for longer, then spread by up to {@link RETRY_JITTER} of that floor.
 *
 * @param retryAfterSeconds - The server's `Retry-After`, if the failure
 *   carried one.
 * @param random - Source in `[0, 1)`; `Math.random` outside tests.
 * @returns Milliseconds to wait.
 */
export const retryDelay = (
  retryAfterSeconds?: number,
  random: () => number = Math.random,
): number =>
  Math.max(BAND_RETRY_MS, (retryAfterSeconds ?? 0) * 1000) *
  (1 + random() * RETRY_JITTER);

/**
 * Wait before a screen re-reads its state after a request timed out.
 *
 * The request may still be running on the server, and reading before it
 * finishes shows the state from before it. The client gives up only after the
 * server's own bounds (5 s for a pool connection, 5 s for a statement) have
 * passed, so a short wait is enough to read the outcome rather than race it.
 */
export const RESYNC_DELAY_MS = 3_000;

/** How often the clock and the window bar redraw. */
export const BAND_CLOCK_MS = 1_000;

/**
 * How often the front of the pass asks for its chips and the questionnaire's
 * state.
 *
 * Matches the back's rotation window, so an announcement to fill in the survey
 * finds the card on every phone within half a minute. Affordable at that rate
 * because the response is a few hundred bytes, and a pass polls only one face
 * at a time, so the room never makes more requests than it does with every
 * pass turned to its back.
 */
export const FRONT_POLL_MS = 30_000;
