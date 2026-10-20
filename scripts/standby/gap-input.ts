import { REDEMPTION_ITEMS } from './gap-plan.ts';

import type {
  Gap,
  GapCheckin,
  GapItemState,
  GapOutcome,
  GapRedemption,
} from './gap-plan.ts';

/**
 * Validates the gap JSON the wrapper pipes into `replay-gap.ts`.
 *
 * The input is produced by a script on another host, so it is checked as
 * strictly as anything from outside: every field, its type, and the closed sets
 * the database constraints enforce. Nothing from it ever reaches SQL text, and
 * a problem names a path and a reason, never a value, so an unexpected field
 * cannot carry personal data into the report.
 *
 * Pure, and imports nothing but `gap-plan.ts`, so it runs with the bare host
 * Node.
 */

/** Most problems listed before the rest are only counted. */
const MAX_PROBLEMS = 50;

const OUTCOMES = [
  'redeemed',
  'marked',
  'reverted',
] as const satisfies readonly GapOutcome[];
const ACTOR_TYPES = ['volunteer', 'admin'] as const;
const ROLES = ['participant', 'volunteer'] as const;

/** Reason codes a correction may carry. Mirrors migration 027. */
const REASONS = ['mis_tap', 'wrong_attendee', 'offline', 'other'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Anchored and bounded, so the nested quantifier cannot backtrack.
const ISO_TIMESTAMP =
  // eslint-disable-next-line security/detect-unsafe-regex
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

type Json = Record<string, unknown>;

/** The result of {@link parseGap}: a gap, or why there is none. */
export type GapParse = { gap: Gap } | { problems: string[] };

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_TIMESTAMP.test(value) &&
  !Number.isNaN(Date.parse(value));

const isOneOf = <T extends string>(
  options: readonly T[],
  value: unknown,
): value is T => typeof value === 'string' && options.includes(value as T);

/**
 * Parses and validates the gap JSON.
 *
 * @param text - The raw input.
 * @returns The typed gap, or every problem found (capped), each as
 *   `path: reason`.
 */
export const parseGap = (text: string): GapParse => {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch {
    return { problems: ['input: not valid JSON'] };
  }

  if (!isRecord(data)) return { problems: ['input: expected a JSON object'] };

  const problems: string[] = [];
  let omitted = 0;

  const fail = (path: string, reason: string): void => {
    if (problems.length < MAX_PROBLEMS) problems.push(`${path}: ${reason}`);
    else omitted++;
  };

  const nonEmpty = (obj: Json, path: string, key: string): string => {
    const value = obj[key];

    if (typeof value === 'string' && value.length > 0) return value;

    fail(`${path}.${key}`, 'expected a non-empty string');

    return '';
  };

  const uuid = (obj: Json, path: string, key: string): string => {
    const value = obj[key];

    if (typeof value === 'string' && UUID.test(value)) return value;

    fail(`${path}.${key}`, 'expected a UUID');

    return '';
  };

  const timestamp = (obj: Json, path: string, key: string): string => {
    const value = obj[key];

    if (isTimestamp(value)) return value;

    fail(`${path}.${key}`, 'expected an ISO 8601 timestamp with a zone');

    return '';
  };

  const choice = <T extends string>(
    obj: Json,
    path: string,
    key: string,
    options: readonly [T, ...T[]],
  ): T => {
    const value = obj[key];

    if (isOneOf(options, value)) return value;

    fail(`${path}.${key}`, `expected one of ${options.join(', ')}`);

    return options[0];
  };

  /** Maps each element of a required array, skipping non-objects. */
  const records = <T>(
    key: string,
    read: (row: Json, path: string) => T,
  ): T[] => {
    const value = data[key];

    if (!Array.isArray(value)) {
      fail(key, 'expected an array');

      return [];
    }

    return value.flatMap((row: unknown, index) => {
      const path = `${key}[${String(index)}]`;

      if (!isRecord(row)) {
        fail(path, 'expected an object');

        return [];
      }

      return [read(row, path)];
    });
  };

  const codes = (key: string): string[] => {
    const value = data[key];

    if (!Array.isArray(value)) {
      fail(key, 'expected an array');

      return [];
    }

    return value.flatMap((code: unknown, index) => {
      if (typeof code === 'string' && code.length > 0) return [code];

      fail(`${key}[${String(index)}]`, 'expected a non-empty string');

      return [];
    });
  };

  const takenAt = timestamp(data, 'input', 'takenAt');

  const checkins = records('checkins', (row, path): GapCheckin => {
    const number = row.checkinNumber;

    if (
      number !== null &&
      !(
        typeof number === 'number' &&
        Number.isSafeInteger(number) &&
        number > 0
      )
    ) {
      fail(`${path}.checkinNumber`, 'expected a positive integer or null');
    }

    return {
      ticketCode: nonEmpty(row, path, 'ticketCode'),
      attendeeId: uuid(row, path, 'attendeeId'),
      role: choice(row, path, 'role', ROLES),
      checkinNumber: typeof number === 'number' ? number : null,
      checkinAt: timestamp(row, path, 'checkinAt'),
    };
  });

  const redemptions = records('redemptions', (row, path): GapRedemption => {
    const outcome = choice(row, path, 'outcome', OUTCOMES);
    const actorType = choice(row, path, 'actorType', ACTOR_TYPES);
    const reason = row.reason ?? null;

    if (reason !== null && !isOneOf(REASONS, reason)) {
      fail(`${path}.reason`, `expected null or one of ${REASONS.join(', ')}`);
    }

    // The table's own consistency check, reported before the insert hits it.
    const correction = outcome !== 'redeemed';

    if (correction && (actorType !== 'admin' || reason === null)) {
      fail(path, `${outcome} needs actorType admin and a reason`);
    }

    if (!correction && reason !== null) {
      fail(`${path}.reason`, 'redeemed must not carry a reason');
    }

    return {
      redemptionId: uuid(row, path, 'redemptionId'),
      ticketCode: nonEmpty(row, path, 'ticketCode'),
      attendeeId: uuid(row, path, 'attendeeId'),
      item: choice(row, path, 'item', REDEMPTION_ITEMS),
      outcome,
      redeemedBy: uuid(row, path, 'redeemedBy'),
      actorType,
      reason: typeof reason === 'string' ? reason : null,
      createdAt: timestamp(row, path, 'createdAt'),
    };
  });

  const items = records('items', (row, path): GapItemState => {
    const redeemedAt = row.redeemedAt;

    if (redeemedAt !== null && !isTimestamp(redeemedAt)) {
      fail(
        `${path}.redeemedAt`,
        'expected an ISO 8601 timestamp with a zone, or null',
      );
    }

    return {
      ticketCode: nonEmpty(row, path, 'ticketCode'),
      item: choice(row, path, 'item', REDEMPTION_ITEMS),
      redeemedAt: typeof redeemedAt === 'string' ? redeemedAt : null,
    };
  });

  const created = codes('created');
  const edited = codes('edited');

  const seen = new Set<string>();

  redemptions.forEach((row, index) => {
    if (seen.has(row.redemptionId)) {
      fail(`redemptions[${String(index)}].redemptionId`, 'duplicate id');
    }

    seen.add(row.redemptionId);
  });

  if (problems.length > 0) {
    if (omitted > 0) problems.push(`…and ${String(omitted)} more`);

    return { problems };
  }

  return { gap: { takenAt, checkins, redemptions, items, created, edited } };
};
