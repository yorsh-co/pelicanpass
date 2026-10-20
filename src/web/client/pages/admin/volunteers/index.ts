import { VOLUNTEERS_COPY } from './messages.ts';
import { openRowsOnClick } from '../shared/row-open.ts';

/**
 * The volunteer list's two enhancements: filters by access, team and a text
 * search, and opening a record by clicking anywhere in its row.
 *
 * Everything works over the rows the server rendered, by their `data-*`
 * attributes, and nothing is written to the URL: the filters are a way of
 * reading one page, not an address. The controls are `hidden` in the template
 * and shown here, so without this bundle the page is the whole list and no
 * control that does nothing.
 *
 * The three filters combine with AND.
 *
 * The name in each row is a submit button, so a record opens without this
 * bundle; the row click only lets the rest of the row press it.
 */

/** Value of the team choice for volunteers with no team. */
const NO_TEAM = 'none';

/** Prefix of a team's value, so that a team can never read as {@link NO_TEAM}. */
const TEAM_PREFIX = 'team:';

const root = document.querySelector<HTMLElement>('[data-volunteers="root"]');
const filters = root?.querySelector<HTMLElement>('[data-volunteers="filters"]');
const search = root?.querySelector<HTMLInputElement>(
  '[data-volunteers="search"]',
);
const teamSelect = root?.querySelector<HTMLSelectElement>(
  '[data-volunteers="team"]',
);
const count = root?.querySelector<HTMLElement>('[data-volunteers="count"]');
const empty = root?.querySelector<HTMLElement>('[data-volunteers="empty"]');
const clear = root?.querySelector<HTMLElement>('[data-volunteers="clear"]');
const chips = [
  ...(root?.querySelectorAll<HTMLButtonElement>('[data-volunteers="tier"]') ??
    []),
];
const rows = [
  ...(root?.querySelectorAll<HTMLElement>('[data-volunteers="list"] > li') ??
    []),
];

/**
 * Folds a string for matching: lowercase, without accents.
 *
 * @param value - Text as typed or as rendered.
 */
const fold = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** What each row's search box match runs against, folded once. */
const haystacks = new Map(
  rows.map((row) => [row, fold(row.dataset.search ?? '')]),
);

let tier = '';

/** Shows the rows every filter admits, and says how many that is. */
const apply = (): void => {
  const needle = fold(search?.value.trim() ?? '');
  const team = teamSelect?.value ?? '';
  let shown = 0;

  for (const row of rows) {
    const rowTeam = row.dataset.team ?? '';

    const visible =
      (tier === '' || row.dataset.tier === tier) &&
      (team === '' ||
        (team === NO_TEAM
          ? rowTeam === ''
          : `${TEAM_PREFIX}${rowTeam}` === team)) &&
      (needle === '' || (haystacks.get(row) ?? '').includes(needle));

    row.hidden = !visible;

    if (visible) shown += 1;
  }

  if (count) count.textContent = VOLUNTEERS_COPY.count(shown);
  if (empty) empty.hidden = shown > 0;
};

/** Removes every filter. */
const reset = (): void => {
  tier = '';

  for (const chip of chips) {
    chip.setAttribute('aria-pressed', String(chip.dataset.tier === ''));
  }

  if (search) search.value = '';
  if (teamSelect) teamSelect.value = '';

  apply();
};

openRowsOnClick(rows);

if (filters && rows.length > 0) {
  filters.hidden = false;

  for (const chip of chips) {
    chip.addEventListener('click', () => {
      tier = chip.dataset.tier ?? '';

      for (const other of chips) {
        other.setAttribute('aria-pressed', String(other === chip));
      }

      apply();
    });
  }

  search?.addEventListener('input', apply);
  teamSelect?.addEventListener('change', apply);
  clear?.addEventListener('click', () => {
    reset();
    search?.focus();
  });
}
