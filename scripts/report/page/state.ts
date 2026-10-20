import { normaliseAgeChoices } from '../core/age.ts';
import { normaliseItem } from '../core/checkin.ts';
import { DEFAULT_FILTERS, normaliseExcludedChurches } from '../core/filter.ts';
import { normaliseExcluded } from '../core/selection.ts';

import type { ItemKey } from '../core/checkin.ts';
import type { SlideId } from '../core/deck.ts';
import type { Filters } from '../core/filter.ts';
import type { Definitions, ReportData } from '../core/model.ts';

/** The report's tabs and their `#token`s. */
export const TABS = [
  { id: 'visao-geral', label: 'Visão geral' },
  { id: 'vendas', label: 'Vendas' },
  { id: 'checkin', label: 'Check-in' },
  { id: 'perfil', label: 'Perfil' },
  { id: 'retiradas', label: 'Retiradas' },
  { id: 'questionario', label: 'Questionário' },
  { id: 'comentarios', label: 'Comentários' },
] as const;

export type TabId = (typeof TABS)[number]['id'];

/** Event data plus where it came from. */
export interface Loaded extends ReportData {
  sample: boolean;
  /** File names in template mode; `null` for embedded data. */
  sources: string[] | null;
}

/** Sortable columns of the church table. */
export type ChurchSortKey =
  'church' | 'tickets' | 'checkedIn' | 'absent' | 'noShowRate';

/** Everything the page remembers between renders. */
export interface State {
  tab: TabId;
  filters: Filters;
  slot: 5 | 15 | 30 | 60;
  item: ItemKey | null;
  /** Cards showing their table instead of the chart. */
  tables: Set<string>;
  churchSort: { key: ChurchSortKey; descending: boolean };
  distribution: Record<'participant' | 'volunteer', string | null>;
  comments: {
    query: string;
    audience: 'follow' | 'all' | 'participant' | 'volunteer';
    question: string;
  };
  /** Showing the file loader. */
  loading: boolean;
  /** Zero-based slide on show in presentation mode; `null` outside it. */
  presenting: number | null;
  /** Slides the organiser left out of the presentation. */
  excludedSlides: SlideId[];
}

/** The embedded definitions and the data on show. */
export const store: {
  definitions: Definitions;
  data: Loaded | null;
  template: boolean;
  hostChurch: string | null;
} = {
  definitions: { participant: [], volunteer: null },
  data: null,
  template: false,
  hostChurch: null,
};

export const state: State = {
  tab: 'visao-geral',
  filters: { ...DEFAULT_FILTERS },
  slot: 5,
  item: null,
  tables: new Set(),
  churchSort: { key: 'tickets', descending: true },
  distribution: { participant: null, volunteer: null },
  comments: { query: '', audience: 'follow', question: '' },
  loading: false,
  presenting: null,
  excludedSlides: [],
};

/**
 * Versioned so a change to the defaults is not masked by what an earlier
 * version stored; bump it when they change.
 */
const STORAGE_KEY = 'pelicanpass-report-v5';

/** Excluded slides are stored apart so they survive changes to the filters. */
const SLIDES_KEY = 'pelicanpass-report-slides';

/** Finds a tab by its `#token`, or `null`. `#igrejas` is the old Perfil. */
export const tabFromToken = (token: string): TabId | null =>
  TABS.find((tab) => tab.id === (token === 'igrejas' ? 'perfil' : token))?.id ??
  null;

/** Restores the last tab, filters and item; storage may be unavailable or stale. */
export const restore = (): void => {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as {
      tab?: string;
      item?: unknown;
      filters?: Partial<Record<keyof Filters, unknown>>;
    };
    const f = saved.filters ?? {};

    state.tab = tabFromToken(saved.tab ?? '') ?? state.tab;
    state.item = normaliseItem(saved.item);
    state.filters = {
      audience:
        f.audience === 'all' ||
        f.audience === 'participant' ||
        f.audience === 'volunteer'
          ? f.audience
          : DEFAULT_FILTERS.audience,
      excludedChurches: normaliseExcludedChurches(f.excludedChurches),
      age: normaliseAgeChoices(f.age),
      ticket:
        f.ticket === 'preSale' || f.ticket === 'walkIn' ? f.ticket : 'all',
    };
  } catch {
    // Unreadable storage only costs the remembered state.
  }
  try {
    state.excludedSlides = normaliseExcluded(
      JSON.parse(localStorage.getItem(SLIDES_KEY) ?? '[]'),
    );
  } catch {
    // Unreadable storage only costs the remembered state.
  }
};

/** Remembers the tab, filters and item. */
export const persist = (): void => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        tab: state.tab,
        filters: state.filters,
        item: state.item,
      }),
    );
  } catch {
    // Private windows and blocked storage are fine.
  }
};

/** Remembers the excluded slides. */
export const persistSlides = (): void => {
  try {
    localStorage.setItem(SLIDES_KEY, JSON.stringify(state.excludedSlides));
  } catch {
    // Private windows and blocked storage are fine.
  }
};

let renderer: () => void = () => undefined;

/** Registers the function that redraws the page. */
export const setRenderer = (render: () => void): void => {
  renderer = render;
};

/**
 * Changes state and redraws.
 *
 * @param patch - Fields to overwrite.
 */
export const update = (patch: Partial<State>): void => {
  Object.assign(state, patch);
  persist();
  renderer();
};
