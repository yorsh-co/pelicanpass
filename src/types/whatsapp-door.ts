/**
 * The door message: the WhatsApp template sent to an attendee created by hand in
 * `/admin/attendees`.
 *
 * Shared with the admin client, which renders the form's checkbox from
 * {@link DoorAvailability} and the post-create toast from {@link DoorOutcome}.
 * Both travel over the API as codes, never prose.
 */

/**
 * Why no door message can be sent right now, whoever asks.
 *
 * - `lockedByEnv`: `WHATSAPP_ENABLED` or `WHATSAPP_DOOR_ENABLED` is off.
 * - `switchedOff`: the switch on the roster is off.
 * - `overBudget`: one more message would take the event past
 *   `WHATSAPP_BUDGET_USD`.
 */
export type DoorUnavailableReason =
  'lockedByEnv' | 'switchedOff' | 'overBudget';

/** Whether a door message could be sent, and why not when it could not. */
export type DoorAvailability =
  { available: true } | { available: false; reason: DoorUnavailableReason };

/**
 * Why one attendee was not messaged although the operator asked.
 *
 * Adds to {@link DoorUnavailableReason} what only a particular attendee,
 * number or operator can hit:
 *
 * - `phoneInvalid`: the stored number cannot be sent to Meta.
 * - `rateLimited`: the operator's own door message budget is spent.
 * - `alreadySent`: this number already received a door message.
 * - `attendeeCapReached`: this attendee has had as many door messages as one
 *   attendee may, whatever the numbers.
 * - `attendeeUnavailable`: the attendee is archived or gone.
 */
export type DoorSkipReason =
  | DoorUnavailableReason
  | 'phoneInvalid'
  | 'rateLimited'
  | 'alreadySent'
  | 'attendeeCapReached'
  | 'attendeeUnavailable';

/**
 * What became of the door message for an attendee just created or saved.
 *
 * `failed` means a send was attempted and did not go out: Meta refused it, or
 * the attempt itself broke. Either way the record was saved, and the attendee
 * needs their pass handed over some other way.
 */
export type DoorOutcome =
  | { status: 'sent' }
  | { status: 'skipped'; reason: DoorSkipReason }
  | { status: 'failed' };

/** What the roster's switch panel shows. */
export interface DoorOverview {
  /** Whether `.env` allows door messages at all. */
  unlocked: boolean;

  /** The switch as stored. Off when no row exists. */
  switchOn: boolean;

  availability: DoorAvailability;

  /** Every message Meta has accepted this event, plus door sends in flight. */
  spentUsd: number;

  budgetUsd: number;

  /** What one door message costs: the dearer of the two door templates. */
  priceUsd: number;
}
