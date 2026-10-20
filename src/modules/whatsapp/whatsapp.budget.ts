import {
  TEMPLATE_PRICE_USD,
  WHATSAPP_TEMPLATES,
  isWhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';

import type { DoorAvailability } from '../../types/whatsapp-door.ts';

/**
 * Pricing WhatsApp spend against the event's budget.
 *
 * Pure, and free of `env`, so the arithmetic the budget cap stands on is tested
 * without a database. Everything is summed in **integer micro-dollars**: the
 * rates are four-decimal fractions, and a float sum of a few thousand of them
 * drifts far enough to put one message either side of the cap.
 */

/** Micro-dollars in one dollar. */
const MICROS = 1_000_000;

/**
 * Converts dollars to integer micro-dollars.
 *
 * @param usd - An amount in dollars.
 */
export const toMicros = (usd: number): number => Math.round(usd * MICROS);

/**
 * Converts integer micro-dollars back to dollars, for display.
 *
 * @param micros - An amount in micro-dollars.
 */
export const fromMicros = (micros: number): number => micros / MICROS;

/**
 * The rate charged for a key no longer in the registry: the dearest one.
 *
 * A send recorded under a template since removed from the registry still cost
 * money. Its category is no longer known, so it is priced high rather than at
 * zero — the cap errs towards stopping early, never towards overspending.
 */
const FALLBACK_MICROS = Math.max(
  ...Object.values(TEMPLATE_PRICE_USD).map(toMicros),
);

/**
 * What one message of a template costs.
 *
 * @param templateKey - Registry key, as stored on a send row.
 * @returns The price in micro-dollars.
 */
export const priceMicros = (templateKey: string): number =>
  isWhatsappTemplateKey(templateKey)
    ? toMicros(TEMPLATE_PRICE_USD[WHATSAPP_TEMPLATES[templateKey].category])
    : FALLBACK_MICROS;

/** How many sends of one template count towards spend. */
export interface SpendRow {
  templateKey: string;
  count: number;
}

/**
 * What a set of sends has cost.
 *
 * @param rows - Counts per template.
 * @returns The total in micro-dollars.
 */
export const spentMicros = (rows: readonly SpendRow[]): number =>
  rows.reduce((sum, row) => sum + row.count * priceMicros(row.templateKey), 0);

/**
 * Whether one more message fits under the budget.
 *
 * Inclusive: a message that lands exactly on the budget is allowed, since the
 * budget is what may be spent.
 *
 * @param spent - Micro-dollars already spent.
 * @param price - Micro-dollars the next message costs.
 * @param budget - Micro-dollars that may be spent in all.
 */
export const fitsBudget = (
  spent: number,
  price: number,
  budget: number,
): boolean => spent + price <= budget;

/** Everything {@link resolveDoorAvailability} weighs. */
export interface DoorAvailabilityInput {
  /** `WHATSAPP_ENABLED` and `WHATSAPP_DOOR_ENABLED` together. */
  unlocked: boolean;
  switchOn: boolean;
  spent: number;
  price: number;
  budget: number;
}

/**
 * Whether a door message can be sent, in the order the reasons are checked.
 *
 * The order is what an operator is told: the `.env` lock first, since nothing
 * on screen can change it, then the switch, then the budget.
 *
 * @param input - The lock, the switch and the money, in micro-dollars.
 */
export const resolveDoorAvailability = (
  input: DoorAvailabilityInput,
): DoorAvailability => {
  if (!input.unlocked) return { available: false, reason: 'lockedByEnv' };

  if (!input.switchOn) return { available: false, reason: 'switchedOff' };

  if (!fitsBudget(input.spent, input.price, input.budget)) {
    return { available: false, reason: 'overBudget' };
  }

  return { available: true };
};

/** Everything {@link resolveReservation} weighs, read under the budget lock. */
export interface ReservationInput {
  /** Whether a door message to this number is already sent or in flight. */
  numberTaken: boolean;

  /** This attendee's door messages already sent or in flight. */
  attendeeSends: number;

  /** How many door messages one attendee may have. */
  cap: number;

  spent: number;
  price: number;
  budget: number;
}

/** Whether a door message may be reserved, or which rule stops it. */
export type ReservationDecision =
  'ok' | 'alreadySent' | 'attendeeCapReached' | 'overBudget';

/**
 * Whether one door message may be reserved.
 *
 * The number first, then the attendee, then the money: the operator is told the
 * most specific reason, and "this number already has it" is the one they can
 * act on at the desk.
 *
 * @param input - The counts and the money, in micro-dollars.
 */
export const resolveReservation = (
  input: ReservationInput,
): ReservationDecision => {
  if (input.numberTaken) return 'alreadySent';

  if (input.attendeeSends >= input.cap) return 'attendeeCapReached';

  if (!fitsBudget(input.spent, input.price, input.budget)) return 'overBudget';

  return 'ok';
};
