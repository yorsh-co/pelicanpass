import type { RedemptionItem } from '../../src/constants/pass.ts';

/**
 * Plans the replay of the "gap" onto the warm standby: the check-ins and
 * redemptions the primary (prod-server) recorded after the restored snapshot's
 * `taken_at`, which the standby (dev-server) never saw.
 *
 * The module is pure, and imports nothing but type declarations, so it runs
 * with the bare host Node. The runner reads {@link Gap} and {@link Standby},
 * calls {@link planGap}, and writes the plan in one transaction only when
 * `problems` is empty. Problems and notices name ticket codes and items, never
 * attendee names or phones.
 */

/** Every collectable item. Mirrors `REDEEMABLE_ITEMS` in `pass.ts`. */
export const REDEMPTION_ITEMS = [
  'tshirt',
  'meal',
  'drink',
  'lunch',
  'tshirt_volunteer',
] as const satisfies readonly RedemptionItem[];

/** Outcomes that change what an attendee holds. */
export type GapOutcome = 'redeemed' | 'marked' | 'reverted';

/** A check-in recorded on prod-server after the snapshot. */
export interface GapCheckin {
  ticketCode: string;
  attendeeId: string;
  role: 'participant' | 'volunteer';
  /** Null for volunteers, who are not numbered. */
  checkinNumber: number | null;
  checkinAt: string;
}

/** A redemption row recorded on prod-server after the snapshot. */
export interface GapRedemption {
  redemptionId: string;
  ticketCode: string;
  attendeeId: string;
  item: RedemptionItem;
  outcome: GapOutcome;
  redeemedBy: string;
  actorType: 'volunteer' | 'admin';
  reason: string | null;
  createdAt: string;
}

/** prod-server's current `*_redeemed_at` for one (ticket, item). */
export interface GapItemState {
  ticketCode: string;
  item: RedemptionItem;
  redeemedAt: string | null;
}

/** What prod-server holds that the restored snapshot lacks. */
export interface Gap {
  takenAt: string;
  checkins: GapCheckin[];
  /** In `created_at` order. */
  redemptions: GapRedemption[];
  /** One entry per (ticket, item) that appears in `redemptions`. */
  items: GapItemState[];
  /** Attendees created on prod-server after the snapshot. */
  created: string[];
  /** Attendees edited after the snapshot by neither a check-in nor a redemption. */
  edited: string[];
}

/** A dev-server attendee row for a ticket code in the gap. */
export interface StandbyAttendee {
  attendeeId: string;
  ticketCode: string;
  role: 'participant' | 'volunteer';
  archived: boolean;
  checkinComplete: boolean;
  checkinNumber: number | null;
  checkinAt: string | null;
  redeemedAt: Record<RedemptionItem, string | null>;
}

/** A redemption row dev-server recorded since the snapshot. */
export interface StandbyActivity {
  redemptionId: string;
  ticketCode: string;
  item: RedemptionItem;
  outcome: string;
  createdAt: string;
}

/** dev-server's current state, read by the runner under row locks. */
export interface Standby {
  /** Restored `checkin_number_last` plus the reserve; dev-server issues above it. */
  numberFloor: number;
  attendees: StandbyAttendee[];
  /** dev-server rows holding any check-in number that appears in the gap. */
  heldNumbers: { checkinNumber: number; ticketCode: string }[];
  /** May include rows from an earlier replay; those are filtered out here. */
  ownActivity: StandbyActivity[];
  /** dev-server redemption ids that match a gap redemption id. */
  replayedIds: string[];
  drawsSinceTakenAt: number;
}

/** What the runner writes, and what it reports. */
export interface GapPlan {
  checkins: {
    attendeeId: string;
    ticketCode: string;
    checkinNumber: number | null;
    checkinAt: string;
  }[];
  /** Gap rows dev-server does not hold yet, in gap order. */
  redemptionInserts: GapRedemption[];
  itemUpdates: {
    attendeeId: string;
    ticketCode: string;
    item: RedemptionItem;
    redeemedAt: string | null;
  }[];
  /** Already in the target state, so a re-run reports no changes. */
  unchanged: { checkins: number; items: number };
  /** Any entry makes the runner refuse the whole run. */
  problems: string[];
  /** Reported, not fatal. Headings without lines are omitted. */
  notices: { heading: string; lines: string[] }[];
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const unique = (values: Iterable<string>): string[] =>
  [...new Set(values)].sort(byText);

/** Compares two timestamps as instants, so `Z` and `+00:00` agree. */
const sameInstant = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);

const isCollected = (outcome: string): boolean =>
  outcome === 'redeemed' || outcome === 'marked';

const keyOf = (ticketCode: string, item: RedemptionItem): string =>
  `${ticketCode}\u0000${item}`;

const state = (collected: boolean): string =>
  collected ? 'collected' : 'not collected';

/**
 * Compares the gap with dev-server and decides what to write.
 *
 * Item state is only copied where dev-server has no activity of its own on the
 * (ticket, item); where both hosts changed it, dev-server's state is kept and the
 * conflict is reported. Check-ins keep prod-server's number and time, so a pass
 * already printed on prod-server's number stays valid.
 *
 * @param gap - What prod-server recorded after the snapshot.
 * @param standby - dev-server's current state.
 * @returns The writes, what was already in place, and what to tell the operator.
 */
export const planGap = (gap: Gap, standby: Standby): GapPlan => {
  const problems = new Set<string>();
  const notice = {
    again: [] as string[],
    archivedCheckin: [] as string[],
    both: [] as string[],
    changedBoth: [] as string[],
    archivedItems: new Set<string>(),
  };

  const plan: GapPlan = {
    checkins: [],
    redemptionInserts: [],
    itemUpdates: [],
    unchanged: { checkins: 0, items: 0 },
    problems: [],
    notices: [],
  };

  const created = new Set(gap.created);
  const attendees = new Map(standby.attendees.map((a) => [a.ticketCode, a]));
  const held = new Map(
    standby.heldNumbers.map((h) => [h.checkinNumber, h.ticketCode]),
  );
  const replayed = new Set(standby.replayedIds);
  const gapIds = new Set(gap.redemptions.map((r) => r.redemptionId));

  for (const code of created) {
    problems.add(
      `${code}: created on prod-server after the snapshot — add it in the attendees editor on dev-server, then run again`,
    );
  }

  /** Looks the ticket up on dev-server, reporting it once if it cannot be used. */
  const resolve = (
    code: string,
    attendeeId: string,
  ): StandbyAttendee | undefined => {
    if (created.has(code)) return undefined;

    const current = attendees.get(code);

    if (!current) {
      problems.add(`${code}: not found on dev-server`);

      return undefined;
    }

    if (current.attendeeId !== attendeeId) {
      problems.add(
        `${code}: a different attendee holds this code on dev-server`,
      );

      return undefined;
    }

    return current;
  };

  for (const gapCheckin of gap.checkins) {
    const { ticketCode: code, checkinNumber: number } = gapCheckin;
    const current = resolve(code, gapCheckin.attendeeId);

    if (!current) continue;

    if (current.role !== gapCheckin.role) {
      problems.add(
        `${code}: role is ${gapCheckin.role} on prod-server but ${current.role} on dev-server`,
      );

      continue;
    }

    const participant = gapCheckin.role === 'participant';

    if (participant) {
      if (number === null) {
        problems.add(
          `${code}: participant check-in has no number on prod-server`,
        );

        continue;
      }

      if (number > standby.numberFloor) {
        problems.add(
          `${code}: check-in number ${String(number)} is above the reserve (${String(standby.numberFloor)}); there were more check-ins than the reserve`,
        );

        continue;
      }

      const holder = held.get(number);

      if (holder !== undefined && holder !== code) {
        problems.add(
          `${code}: check-in number ${String(number)} is already held by another ticket on dev-server`,
        );

        continue;
      }
    }

    const alreadyDone = participant
      ? current.checkinComplete && current.checkinNumber === number
      : current.checkinComplete &&
        current.checkinAt !== null &&
        sameInstant(current.checkinAt, gapCheckin.checkinAt);

    if (alreadyDone) {
      plan.unchanged.checkins++;
    } else if (current.checkinComplete) {
      notice.again.push(
        participant
          ? `${code}: dev-server ${current.checkinNumber === null ? 'has no number' : `#${String(current.checkinNumber)}`}, prod-server #${String(number)} not used`
          : `${code}: volunteer, no numbers; dev-server time kept`,
      );
    } else if (current.archived) {
      notice.archivedCheckin.push(code);
    } else {
      plan.checkins.push({
        attendeeId: current.attendeeId,
        ticketCode: code,
        checkinNumber: number,
        checkinAt: gapCheckin.checkinAt,
      });
    }
  }

  plan.redemptionInserts = gap.redemptions.filter(
    (row) => !replayed.has(row.redemptionId),
  );

  const target = new Map(
    gap.items.map((s) => [keyOf(s.ticketCode, s.item), s.redeemedAt]),
  );
  /** The last gap row per (ticket, item). */
  const groups = new Map<string, GapRedemption>();

  for (const row of gap.redemptions) {
    const key = keyOf(row.ticketCode, row.item);

    groups.set(key, row);
  }

  const ownRows = new Map<string, StandbyActivity>();

  for (const row of standby.ownActivity) {
    if (gapIds.has(row.redemptionId)) continue;

    const key = keyOf(row.ticketCode, row.item);
    const last = ownRows.get(key);

    if (!last || Date.parse(row.createdAt) >= Date.parse(last.createdAt)) {
      ownRows.set(key, row);
    }
  }

  for (const [key, last] of groups) {
    const { ticketCode: code, item } = last;
    const current = resolve(code, last.attendeeId);

    if (!current) continue;

    if (current.archived) {
      notice.archivedItems.add(code);

      continue;
    }

    if (!target.has(key)) {
      problems.add(
        `${code} ${item}: prod-server item state missing from the export`,
      );

      continue;
    }

    const wanted = target.get(key) ?? null;
    const own = ownRows.get(key);

    if (own) {
      const gapCollected = isCollected(last.outcome);
      const ownCollected = isCollected(own.outcome);

      if (gapCollected && ownCollected) {
        notice.both.push(`${code} ${item}`);
      } else if (!gapCollected && !ownCollected) {
        plan.unchanged.items++;
      } else {
        notice.changedBoth.push(
          `${code} ${item}: prod-server ${state(gapCollected)}, dev-server ${state(ownCollected)}`,
        );
      }
    } else if (sameInstant(current.redeemedAt[item], wanted)) {
      plan.unchanged.items++;
    } else {
      plan.itemUpdates.push({
        attendeeId: current.attendeeId,
        ticketCode: code,
        item,
        redeemedAt: wanted,
      });
    }
  }

  plan.checkins.sort(
    (a, b) =>
      Date.parse(a.checkinAt) - Date.parse(b.checkinAt) ||
      byText(a.ticketCode, b.ticketCode),
  );
  plan.itemUpdates.sort(
    (a, b) => byText(a.ticketCode, b.ticketCode) || byText(a.item, b.item),
  );
  plan.problems = [...problems].sort(byText);

  const sections: { heading: string; lines: string[] }[] = [
    {
      heading: 'Checked in again on dev-server — keeps its dev-server number',
      lines: notice.again,
    },
    {
      heading: 'Archived on dev-server — not checked in',
      lines: notice.archivedCheckin,
    },
    {
      heading: 'Archived on dev-server — item state not changed',
      lines: [...notice.archivedItems],
    },
    {
      heading: 'Collected on both hosts — handed over twice',
      lines: notice.both,
    },
    {
      heading: "Changed on both hosts — dev-server's state kept",
      lines: notice.changedBoth,
    },
    {
      heading:
        'Changed on prod-server in the gap by something other than a check-in or redemption — compare by hand',
      lines: gap.edited,
    },
    {
      heading:
        'Raffle already drawn on dev-server — replayed numbers were not in that pool',
      lines:
        standby.drawsSinceTakenAt > 0
          ? [`${String(standby.drawsSinceTakenAt)} draw(s) since the snapshot`]
          : [],
    },
  ];

  plan.notices = sections
    .map(({ heading, lines }) => ({ heading, lines: unique(lines) }))
    .filter(({ lines }) => lines.length > 0);

  return plan;
};
