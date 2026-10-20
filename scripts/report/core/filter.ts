import { UNKNOWN_AGE, ageBandOf } from './age.ts';
import { UNKNOWN_CHURCH, churchKey } from './metrics.ts';

import type { AgeChoice } from './age.ts';
import type { Attendee } from './checkin.ts';

type Role = Attendee['role'];

/** Church of the staff invites, which are participant rows. */
export const STAFF_CHURCH = 'Convidado';

/** The report's global filters. */
export interface Filters {
  audience: 'all' | Role;
  /**
   * Churches left out, as displayed ({@link UNKNOWN_CHURCH} for blank ones).
   * An exclusion list, so churches in later files are included; participants
   * only.
   */
  excludedChurches: readonly string[];
  /** Age bands and {@link UNKNOWN_AGE}; empty for any; participants only. */
  age: readonly AgeChoice[];
  /** How the ticket was bought; participants only. */
  ticket: 'all' | 'preSale' | 'walkIn';
}

/** No filter set. */
export const NO_FILTERS: Readonly<Filters> = {
  audience: 'all',
  excludedChurches: [],
  age: [],
  ticket: 'all',
};

/**
 * What the report opens with, and what clearing the filters returns to, when
 * the data has ages. See {@link defaultFiltersFor}.
 */
export const DEFAULT_FILTERS: Readonly<Filters> = {
  audience: 'participant',
  excludedChurches: [STAFF_CHURCH],
  age: [],
  ticket: 'all',
};

/** Drops blanks and repeated keys, then sorts for pt-BR. */
const sortedDistinct = (names: readonly string[]): string[] => {
  const byKey = new Map<string, string>();

  for (const name of names) {
    const key = churchKey(name);

    if (key !== '' && !byKey.has(key)) byKey.set(key, name);
  }

  return [...byKey.values()].sort((a, b) => a.localeCompare(b, 'pt-BR'));
};

/** Church names reduced to their sorted, distinct keys. */
const keySet = (names: readonly string[]): string[] =>
  [...new Set(names.map(churchKey))].sort();

/**
 * Tells whether the excluded churches equal the default, ignoring order, case
 * and spacing.
 *
 * @param filters - The active filters.
 */
export const isChurchFilterDefault = (filters: Filters): boolean => {
  const current = keySet(filters.excludedChurches);
  const standard = keySet(DEFAULT_FILTERS.excludedChurches);

  return (
    current.length === standard.length &&
    current.every((key, i) => key === standard[i])
  );
};

/**
 * Tells whether the filters equal the defaults.
 *
 * @param filters - The active filters.
 */
export const isDefaultFilters = (filters: Filters): boolean =>
  filters.audience === DEFAULT_FILTERS.audience &&
  isChurchFilterDefault(filters) &&
  filters.age.length === DEFAULT_FILTERS.age.length &&
  filters.age.every((choice, i) => choice === DEFAULT_FILTERS.age[i]) &&
  filters.ticket === DEFAULT_FILTERS.ticket;

/**
 * Tells whether a filter that only describes participants is set, which
 * leaves volunteers out of every attendance view. Church exclusions do not
 * count: volunteers have no church, so they are never removed by them.
 *
 * @param filters - The active filters.
 */
export const excludesVolunteers = (filters: Filters): boolean =>
  filters.age.length > 0 || filters.ticket !== 'all';

/**
 * Tells whether a filter the anonymous questionnaires cannot honour (church,
 * age or ticket) differs from what the report opens with.
 *
 * @param filters - The active filters.
 */
export const ignoredBySurveys = (filters: Filters): boolean =>
  excludesVolunteers(filters) || !isChurchFilterDefault(filters);

/**
 * Roles that contribute to the attendance views under the filters.
 *
 * @param filters - The active filters.
 */
export const activeRoles = (filters: Filters): Role[] => {
  if (filters.audience !== 'all') {
    return filters.audience === 'volunteer' && excludesVolunteers(filters)
      ? []
      : [filters.audience];
  }

  return excludesVolunteers(filters)
    ? ['participant']
    : ['participant', 'volunteer'];
};

/**
 * Applies the filters to the registrations.
 *
 * @param attendees - Every row of the export.
 * @param filters - The active filters.
 */
export const applyFilters = (
  attendees: readonly Attendee[],
  filters: Filters,
): Attendee[] => {
  const roles = activeRoles(filters);
  const excluded = new Set(filters.excludedChurches.map(churchKey));

  return attendees.filter((a) => {
    if (!roles.includes(a.role)) return false;
    if (a.role === 'volunteer') return true;
    if (excluded.has(churchKey(a.church ?? UNKNOWN_CHURCH))) return false;
    if (
      filters.age.length > 0 &&
      !filters.age.includes(ageBandOf(a) ?? UNKNOWN_AGE)
    ) {
      return false;
    }
    if (filters.ticket === 'walkIn') return a.walkIn === true;
    if (filters.ticket === 'preSale') return a.walkIn === false;

    return true;
  });
};

/**
 * Adds a church to the exclusions, or removes it when already excluded.
 * Names match by {@link churchKey}, and removal drops every stored variant.
 *
 * @param excluded - The current exclusions.
 * @param name - The church as displayed.
 * @returns A new list sorted for pt-BR, without repeated keys.
 */
export const toggleChurch = (
  excluded: readonly string[],
  name: string,
): string[] => {
  const key = churchKey(name);

  return sortedDistinct(
    excluded.some((n) => churchKey(n) === key)
      ? excluded.filter((n) => churchKey(n) !== key)
      : [...excluded, name],
  );
};

/**
 * Excludes every church except those to keep.
 *
 * @param names - Every church in the data.
 * @param keep - Churches to leave included.
 * @returns A new list sorted for pt-BR, without repeated keys.
 */
export const excludeAllBut = (
  names: readonly string[],
  keep: readonly string[],
): string[] => {
  const kept = new Set(keep.map(churchKey));

  return sortedDistinct(names.filter((n) => !kept.has(churchKey(n))));
};

/**
 * Reads saved church exclusions, tolerating stale or corrupt storage.
 *
 * @param value - The stored value.
 * @returns The trimmed, de-duplicated names, or the default exclusions when
 * it is not an array (such as the single church older builds saved).
 */
export const normaliseExcludedChurches = (value: unknown): string[] =>
  Array.isArray(value)
    ? sortedDistinct(
        value
          .filter((n): n is string => typeof n === 'string')
          .map((n) => n.trim()),
      )
    : [...DEFAULT_FILTERS.excludedChurches];

/** Text of the church dropdown button. */
export interface ChurchSelectionLabel {
  /** Short text for the button. */
  text: string;
  /** Full text, listing the names the short one counts. */
  full: string;
}

/**
 * Summarises which churches are included, for the dropdown button. Only
 * churches present in the data count.
 *
 * @param excluded - The excluded churches.
 * @param names - Every church in the data, as displayed.
 */
export const churchSelectionLabel = (
  excluded: readonly string[],
  names: readonly string[],
): ChurchSelectionLabel => {
  const keys = new Set(excluded.map(churchKey));
  const left = names.filter((n) => keys.has(churchKey(n)));
  const kept = names.filter((n) => !keys.has(churchKey(n)));

  if (left.length === 0) return { text: 'Todas', full: 'Todas' };
  if (kept.length === 0) return { text: 'Nenhuma', full: 'Nenhuma' };
  if (kept.length === 1) {
    return { text: kept[0] ?? '', full: kept[0] ?? '' };
  }
  if (kept.length === 2) {
    return { text: '2 igrejas', full: kept.join(' e ') };
  }
  const full = `Todas exceto ${left.join(', ')}`;

  return {
    text: left.length === 1 ? full : `Todas exceto ${String(left.length)}`,
    full,
  };
};
