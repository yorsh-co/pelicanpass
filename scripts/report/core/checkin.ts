import { ageDetail } from './age.ts';
import { parseTable, unguard } from './csv.ts';

import type { AgeDetail } from './age.ts';

/** What can be handed out at the event. */
export type ItemKey = 'meal' | 'drink' | 'tshirt' | 'lunch' | 'tshirtVolunteer';

/** Display names of the items, in report order. */
export const ITEM_LABELS: Readonly<Record<ItemKey, string>> = {
  meal: 'Lanche',
  drink: 'Bebida',
  tshirt: 'Camiseta',
  lunch: 'Almoço',
  tshirtVolunteer: 'Camiseta de voluntário',
};

/** Item keys in report order. */
export const ITEM_KEYS = Object.keys(ITEM_LABELS) as ItemKey[];

/**
 * Reads a saved item, tolerating stale or corrupt storage.
 *
 * @param value - The stored value.
 * @returns The item key, or `null` when it is not a known one.
 */
export const normaliseItem = (value: unknown): ItemKey | null =>
  ITEM_KEYS.find((key) => key === value) ?? null;

/** One item for one attendee: what they were entitled to, and when it was taken. */
export interface ItemState {
  option: string | null;
  /** Epoch milliseconds. */
  redeemedAt: number | null;
}

/**
 * One registration. Deliberately holds no ticket code or other identifier.
 */
export interface Attendee {
  role: 'participant' | 'volunteer';
  /** Bought on event day; `null` when the export carries no ticket codes. */
  walkIn: boolean | null;
  church: string | null;
  /**
   * Age group: single years from 13 to 18, collapsed below and above, so
   * no other exact age is kept. `null` when blank or absent.
   */
  ageDetail: AgeDetail | null;
  /** Calendar date the ticket was sold, `YYYY-MM-DD`; `null` when unknown. */
  saleDate: string | null;
  checkedIn: boolean;
  /** Epoch milliseconds. */
  checkinAt: number | null;
  archived: boolean;
  items: Record<ItemKey, ItemState>;
}

/** Column pairs per item in the export. */
const ITEM_COLUMNS: Readonly<Record<ItemKey, readonly [string, string]>> = {
  meal: ['meal_option', 'meal_redeemed_at'],
  drink: ['drink_option', 'drink_redeemed_at'],
  tshirt: ['tshirt_size', 'tshirt_redeemed_at'],
  lunch: ['lunch_option', 'lunch_redeemed_at'],
  tshirtVolunteer: ['tshirt_volunteer_size', 'tshirt_volunteer_redeemed_at'],
};

const REQUIRED = [
  'attendee_role',
  'checkin_complete',
  'checkin_number',
  'checkin_at',
  'archived_at',
  ...Object.values(ITEM_COLUMNS).flat(),
];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BR_DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CLOCK = /^(\d{2}):(\d{2}):(\d{2})$/;
const FRACTION = /^\.\d+/;
/** Oldest age accepted in the `age` column. */
const MAX_AGE = 120;

/**
 * Parses a Postgres or ISO timestamp with an offset, e.g.
 * `2026-10-18 14:03:22.123456-03`.
 *
 * @returns Epoch milliseconds, or `null` if the text is not such a timestamp.
 */
const parseTimestamp = (text: string): number | null => {
  const date = DATE.exec(text.slice(0, 10));
  const clock = CLOCK.exec(text.slice(11, 19));
  const rest = text.slice(19);
  const fraction = FRACTION.exec(rest)?.[0] ?? '';
  const zone = rest.slice(fraction.length);
  const digits = zone.slice(1).replace(':', '');

  if (!date || !clock || !/^[ T]$/.test(text.charAt(10))) return null;
  if (zone !== 'Z') {
    const valid =
      /^[+-]/.test(zone) &&
      /^\d+$/.test(digits) &&
      [2, 4].includes(digits.length);

    if (!valid) return null;
  }
  const sign = zone.startsWith('-') ? -1 : 1;
  const offset =
    zone === 'Z'
      ? 0
      : sign *
        (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) *
        60_000;
  const ms = Number(fraction.slice(1, 4).padEnd(3, '0'));

  return (
    Date.UTC(
      Number(date[1]),
      Number(date[2]) - 1,
      Number(date[3]),
      Number(clock[1]),
      Number(clock[2]),
      Number(clock[3]),
      ms,
    ) - offset
  );
};

/**
 * Parses a sale date as `YYYY-MM-DD` or `DD/MM/YYYY`, optionally followed by
 * a space or `T` and a time, which is dropped.
 *
 * @returns The date as `YYYY-MM-DD`, or `null` if the text is not a real
 * calendar date in one of those forms.
 */
const parseSaleDate = (text: string): string | null => {
  const rest = text.slice(10);

  if (rest !== '' && !/^[ T]/.test(rest)) return null;
  const head = text.slice(0, 10);
  const iso = ISO_DATE.exec(head);
  const br = BR_DATE.exec(head);
  const [year, month, day] = iso
    ? [iso[1], iso[2], iso[3]]
    : br
      ? [br[3], br[2], br[1]]
      : [];

  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const check = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  const real =
    check.getUTCFullYear() === Number(year) &&
    check.getUTCMonth() === Number(month) - 1 &&
    check.getUTCDate() === Number(day);

  return real ? `${year}-${month}-${day}` : null;
};

/**
 * Parses the check-in results export.
 *
 * `ticket_code`, if present, is used only to tell walk-ins (codes starting
 * with `d`) from pre-sale tickets and is then discarded. An optional `church`
 * column is read as the church, and an optional `age` column as the age group;
 * ages outside 13 to 18 are collapsed and no exact age is kept. An optional
 * `sale_date` column is read as the date the ticket was sold, keeping the
 * date only.
 *
 * @param text - The CSV contents.
 * @throws Error with a pt-BR message when required columns are missing or a
 * cell cannot be read; the message is meant for the user.
 */
export const parseCheckin = (text: string): Attendee[] => {
  const { header, records } = parseTable(text);
  const missing = REQUIRED.filter((name) => !header.includes(name));

  if (missing.length > 0) {
    throw new Error(
      `Arquivo de check-in inválido: faltam as colunas ${missing.join(', ')}.`,
    );
  }
  const hasCode = header.includes('ticket_code');

  return records.map((record, index) => {
    const line = index + 2;
    const fail = (column: string): Error =>
      new Error(
        `Arquivo de check-in inválido: coluna ${column}, linha ${String(line)}.`,
      );
    const cell = (name: string): string => record[name] ?? '';
    const textCell = (name: string): string | null => {
      const value = unguard(cell(name));

      return value === '' ? null : value;
    };
    const time = (name: string): number | null => {
      const value = cell(name).trim();

      if (value === '') return null;
      const parsed = parseTimestamp(value);
      if (parsed === null) throw fail(name);

      return parsed;
    };

    const detail = (name: string): AgeDetail | null => {
      const value = textCell(name)?.trim() ?? '';

      if (value === '') return null;
      const age = Number(value);
      if (!/^\d{1,3}$/.test(value) || age > MAX_AGE) throw fail(name);

      return ageDetail(age);
    };

    const sale = (name: string): string | null => {
      const value = textCell(name)?.trim() ?? '';

      if (value === '') return null;
      const parsed = parseSaleDate(value);
      if (parsed === null) throw fail(name);

      return parsed;
    };

    const role = textCell('attendee_role');
    if (role !== 'participant' && role !== 'volunteer') {
      throw fail('attendee_role');
    }
    const complete = cell('checkin_complete').trim();
    if (complete !== 't' && complete !== 'f') throw fail('checkin_complete');

    const church = textCell('church')?.trim() ?? null;
    const ageDetailOfRow = detail('age');
    const saleDate = sale('sale_date');
    const code = hasCode ? textCell('ticket_code') : null;
    const items = Object.fromEntries(
      ITEM_KEYS.map((key) => {
        const [optionColumn, redeemedColumn] = ITEM_COLUMNS[key];

        return [
          key,
          { option: textCell(optionColumn), redeemedAt: time(redeemedColumn) },
        ];
      }),
    ) as Record<ItemKey, ItemState>;

    return {
      role,
      walkIn: code === null ? null : code.toLowerCase().startsWith('d'),
      church: church === '' ? null : church,
      ageDetail: ageDetailOfRow,
      saleDate,
      checkedIn: complete === 't',
      checkinAt: time('checkin_at'),
      archived: time('archived_at') !== null,
      items,
    };
  });
};
