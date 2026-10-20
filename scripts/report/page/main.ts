import { COPY_DEFAULTS } from '../../../src/constants/copy-defaults.ts';
import {
  activeRoles,
  DEFAULT_FILTERS,
  applyFilters,
  excludesVolunteers,
  isDefaultFilters,
} from '../core/filter.ts';
import { AGE_BANDS, UNKNOWN_AGE, ageBandOf, toggleAge } from '../core/age.ts';
import { byChurch } from '../core/metrics.ts';
import { SAMPLE_HOST_CHURCH } from '../core/sample.ts';
import { checkin } from './checkin.ts';
import { churchMenu } from './church-menu.ts';
import { comments } from './comments.ts';
import { disposeCharts, mountCharts } from './charts.ts';
import { el } from './dom.ts';
import { fmtDateTime } from './format.ts';
import { loader } from './loader.ts';
import { overview } from './overview.ts';
import { profile, profileData } from './profile.ts';
import { slideFromHash } from '../core/navigation.ts';
import { openSlidePicker } from './present/picker.ts';
import { presentation } from './present/stage.ts';
import { redemptions } from './redemptions.ts';
import { hasSales, sales } from './sales.ts';
import {
  restore,
  setRenderer,
  state,
  store,
  TABS,
  tabFromToken,
  update,
} from './state.ts';
import { survey } from './survey.ts';
import {
  currentTheme,
  resolvePalette,
  toggleTheme,
  watchTheme,
} from './theme.ts';
import { segmented, themeToggle, toggleGroup } from './ui.ts';

import type { AgeChoice } from '../core/age.ts';
import type { ReportPayload } from '../core/model.ts';
import type { Ctx } from './ctx.ts';
import type { TabId } from './state.ts';
import type { Palette } from './theme.ts';

const root = document.getElementById('app');

/** Whether echarts has loaded; charts cannot draw before. */
const chartsReady = (): boolean => 'echarts' in globalThis;

const VIEWS: Record<TabId, (ctx: Ctx) => HTMLElement> = {
  'visao-geral': overview,
  vendas: sales,
  checkin,
  retiradas: redemptions,
  perfil: profile,
  questionario: survey,
  comentarios: comments,
};

const header = (ctx?: Ctx): HTMLElement => {
  const data = store.data;
  const meta = [
    data?.sources
      ? `Arquivos: ${data.sources.join(', ')}`
      : data && !data.sample
        ? `Gerado em ${fmtDateTime(data.generatedAt)}`
        : null,
    'Códigos de ingresso removidos na leitura',
  ].filter((text) => text !== null);

  return el(
    'header',
    { class: 'page-head' },
    el(
      'div',
      {},
      el('h1', {}, `${COPY_DEFAULTS.eventName} · Relatório pós-evento`),
      el('p', { class: 'meta' }, meta.join(' · ')),
    ),
    el(
      'div',
      { class: 'head-actions' },
      store.template && data
        ? el(
            'button',
            {
              class: 'button',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  update({ loading: true });
                },
              },
            },
            'Trocar arquivos',
          )
        : null,
      ctx && !state.loading
        ? el(
            'button',
            {
              class: 'button',
              attrs: { type: 'button' },
              on: {
                click: () => {
                  openSlidePicker(ctx, 'Começar apresentação', () => {
                    update({ presenting: 0 });
                  });
                },
              },
            },
            'Apresentar',
          )
        : null,
      themeToggle(currentTheme(), toggleTheme),
    ),
  );
};

const filterBar = (ctx: Ctx): HTMLElement => {
  const { filters } = state;
  const all = ctx.data.attendees;
  const names = byChurch(all).map((c) => c.church);
  const has = profileData(all);
  const hasUnknownAge = all.some(
    (a) => !a.archived && a.role === 'participant' && ageBandOf(a) === null,
  );
  const hasWalkIn = all.some((a) => a.walkIn !== null);

  return el(
    'div',
    { class: 'filters' },
    segmented(
      'Público',
      [
        { value: 'all', label: 'Todos' },
        { value: 'participant', label: 'Participantes' },
        { value: 'volunteer', label: 'Voluntários' },
      ] as const,
      filters.audience,
      (audience) => {
        update({ filters: { ...filters, audience } });
      },
    ),
    has.church ? churchMenu(names) : null,
    has.age
      ? toggleGroup(
          'Idade',
          'Nenhuma selecionada = todas as idades',
          [
            ...AGE_BANDS.map((band) => ({ value: band, label: band })),
            ...(hasUnknownAge
              ? [
                  {
                    value: UNKNOWN_AGE,
                    label: 'N/I',
                    title: UNKNOWN_AGE,
                  },
                ]
              : []),
          ] as readonly { value: AgeChoice; label: string; title?: string }[],
          filters.age,
          (choice) => {
            update({
              filters: { ...filters, age: toggleAge(filters.age, choice) },
            });
          },
        )
      : null,
    hasWalkIn
      ? segmented(
          'Ingresso',
          [
            { value: 'all', label: 'Todos' },
            { value: 'preSale', label: 'Antecipado' },
            { value: 'walkIn', label: 'No dia' },
          ] as const,
          filters.ticket,
          (ticket) => {
            update({ filters: { ...filters, ticket } });
          },
        )
      : null,
    !isDefaultFilters(filters)
      ? el(
          'button',
          {
            class: 'link-button',
            attrs: { type: 'button' },
            on: {
              click: () => {
                update({ filters: { ...DEFAULT_FILTERS } });
              },
            },
          },
          'Limpar filtros',
        )
      : null,
  );
};

const tabBar = (tabs: readonly { id: TabId; label: string }[]): HTMLElement =>
  el(
    'nav',
    { class: 'tabs', attrs: { 'aria-label': 'Seções do relatório' } },
    ...tabs.map((tab) =>
      el(
        'a',
        {
          attrs: {
            href: `#${tab.id}`,
            'aria-current': String(tab.id === state.tab),
          },
        },
        tab.label,
      ),
    ),
  );

/** Keeps the active tab visible and fades the edge that has more tabs. */
const watchTabs = (): void => {
  const nav = document.querySelector<HTMLElement>('.tabs');

  if (!nav) return;
  const fade = (): void => {
    nav.classList.toggle('fade-start', nav.scrollLeft > 1);
    nav.classList.toggle(
      'fade-end',
      nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1,
    );
  };

  nav.addEventListener('scroll', fade, { passive: true });
  nav
    .querySelector('[aria-current="true"]')
    ?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  fade();
};

/** The report page: header, filters and the active tab. */
const tabbedPage = (ctx: Ctx): HTMLElement[] => {
  const { data, filters } = ctx;
  const has = profileData(data.attendees);
  const tabs = TABS.filter(
    (t) =>
      (t.id !== 'perfil' || has.church || has.age) &&
      (t.id !== 'vendas' || hasSales(data.attendees)),
  );
  const tab = tabs.some((t) => t.id === state.tab) ? state.tab : 'visao-geral';

  if (location.hash.slice(1) !== tab) history.replaceState(null, '', `#${tab}`);
  const notices: HTMLElement[] = [];

  if (data.sample)
    notices.push(
      el(
        'div',
        { class: 'banner', attrs: { role: 'status' } },
        'Dados de exemplo — não são dados do evento.',
      ),
    );
  if (
    excludesVolunteers(filters) &&
    tab !== 'questionario' &&
    tab !== 'comentarios'
  ) {
    notices.push(
      el(
        'p',
        { class: 'note' },
        'Idade e ingresso valem só para participantes: os voluntários ficam fora destas visões.',
      ),
    );
  }

  return [
    el('div', { class: 'page' }, header(ctx), ...notices),
    el(
      'div',
      { class: 'sticky' },
      el('div', { class: 'page' }, filterBar(ctx)),
    ),
    el(
      'div',
      { class: 'page' },
      tabBar(tabs),
      el('main', { attrs: { id: 'conteudo' } }, VIEWS[tab](ctx)),
    ),
  ];
};

/** Credit line at the foot of every page. */
const credit = (): HTMLElement =>
  el('footer', { class: 'page credit' }, 'Produzido por Josh Porter');

const render = (): void => {
  if (!root) return;
  const focused = document.activeElement;
  const focusKey =
    focused instanceof HTMLElement ? focused.dataset.focus : undefined;
  const selection =
    focused instanceof HTMLInputElement
      ? ([focused.selectionStart, focused.selectionEnd] as const)
      : null;
  const scroll = window.scrollY;

  disposeCharts();
  let palette: Palette | null = null;
  const nodes: HTMLElement[] = [];

  if (!store.data || state.loading) {
    nodes.push(el('div', { class: 'page' }, header(), loader()), credit());
  } else if (!chartsReady()) {
    nodes.push(
      el(
        'div',
        { class: 'page' },
        header(),
        el(
          'p',
          { class: 'error', attrs: { role: 'alert' } },
          'Não foi possível carregar a biblioteca de gráficos (ECharts). Verifique a conexão e recarregue a página.',
        ),
      ),
    );
  } else {
    const data = store.data;
    palette = resolvePalette();
    const filters = state.filters;
    const ctx: Ctx = {
      data,
      definitions: store.definitions,
      hostChurch: data.sample ? SAMPLE_HOST_CHURCH : store.hostChurch,
      filters,
      rows: applyFilters(data.attendees, filters),
      roles: activeRoles(filters),
      palette,
    };

    nodes.push(
      ...(state.presenting === null
        ? [...tabbedPage(ctx), credit()]
        : [presentation(ctx)]),
    );
  }
  root.replaceChildren(...nodes);
  if (palette) mountCharts(palette);
  watchTabs();
  if (focusKey !== undefined) {
    const target = [
      ...document.querySelectorAll<HTMLElement>('[data-focus]'),
    ].find((n) => n.dataset.focus === focusKey);

    target?.focus({ preventScroll: true });
    if (
      target instanceof HTMLInputElement &&
      selection?.[0] != null &&
      selection[1] != null
    )
      target.setSelectionRange(selection[0], selection[1]);
  }
  window.scrollTo({ top: scroll });
};

const readPayload = (): ReportPayload => {
  const node = document.getElementById('report-data');

  return JSON.parse(node?.textContent ?? '{}') as ReportPayload;
};

const start = (): void => {
  const payload = readPayload();

  store.definitions = payload.definitions;
  store.hostChurch = payload.hostChurch;
  store.template = payload.data === null;
  store.data = payload.data && {
    ...payload.data,
    sample: false,
    sources: null,
  };
  restore();
  const hashed = tabFromToken(location.hash.slice(1));
  const slide = slideFromHash(location.hash);

  if (hashed) state.tab = hashed;
  if (slide !== null && store.data) state.presenting = slide;
  state.loading = store.data === null;
  setRenderer(render);
  window.addEventListener('hashchange', () => {
    const slide = slideFromHash(location.hash);
    const tab = tabFromToken(location.hash.slice(1));

    if (slide !== null) {
      if (store.data && !state.loading && slide !== state.presenting)
        update({ presenting: slide });
    } else if (tab && (tab !== state.tab || state.presenting !== null))
      update({ tab, presenting: null });
  });
  watchTheme(render);
  render();
};

start();
