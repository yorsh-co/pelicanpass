/**
 * Locals for every top-level view, with fictional attendees and a pinned clock.
 *
 * Shared by the view snapshot suite and the static demo build, so the demo
 * renders exactly the markup the snapshots guard.
 */

import { env } from '../../config/env.ts';
import { parseAttendeeFilters } from '../../constants/attendee-filters.ts';
import { TICKET_INPUT_PATTERN } from '../../constants/ticket.ts';
import {
  NICKNAME_INPUT_PATTERN,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
} from '../../constants/nickname.ts';
import {
  REASONS_FOR,
  REDEMPTION_ITEM_ORDER,
  REDEMPTION_STATUS_FILTERS,
  parseRedemptionFilters,
} from '../../constants/redemptions.ts';
import { getCopy, getMessages, inlineCatalogs } from '../../i18n/server.ts';

import { ITEM_OPTIONS_BY_ROLE } from '../../modules/admin/admin.item-options.ts';
import { surveyFor } from '../../modules/survey/survey.definition.ts';
import { metricsLabels } from '../../modules/metrics/metrics.labels.ts';
import { closingView, landingView } from '../landing/landing-view.ts';
import { NOTICES } from '../content/notices.ts';

import type { MessagesOf } from '../../i18n/generated/registry.ts';
import type { Locale } from '../../i18n/locales.ts';

/** Pinned clock the fixtures are written against. */
export const NOW = Date.UTC(2026, 9, 17, 14, 30, 0);
/** Pinned opening time, after {@link NOW}. */
export const OPENS_AT = Date.UTC(2026, 9, 17, 18, 0, 0);
/** Pinned release id. */
export const RELEASE = 'test-release';

export type Locals = Record<string, unknown>;

/** What a fixture may read from the response it is rendered on. */
export interface Context {
  locale: Locale;
  /** Release id shown on the status page. */
  release: string;
  chrome: MessagesOf['chrome'];
  /** The administrator catalogs, as `adminMessages` builds them in the router. */
  m: {
    shell: MessagesOf['admin-shell'];
    login: MessagesOf['admin-login'];
    attendees: MessagesOf['admin-attendees'];
    lookup: MessagesOf['admin-lookup'];
    whatsapp: MessagesOf['admin-whatsapp'];
    metrics: MessagesOf['admin-metrics'];
    survey: MessagesOf['admin-survey'];
    pass: MessagesOf['admin-pass'];
    redemptions: MessagesOf['admin-redemptions'];
    tshirts: MessagesOf['admin-tshirts'];
    volunteers: MessagesOf['admin-volunteers'];
  };
}

export interface ViewCase {
  /** Snapshot file name, without extension. */
  name: string;
  view: string;
  /** Renders inside the administrator shell (`adminChrome`'s locals). */
  admin?: true;
  locals: (ctx: Context) => Locals;
}

export const adminMessages = (locale: Locale): Context['m'] => ({
  shell: getMessages(locale, 'admin-shell'),
  login: getMessages(locale, 'admin-login'),
  attendees: getMessages(locale, 'admin-attendees'),
  lookup: getMessages(locale, 'admin-lookup'),
  whatsapp: getMessages(locale, 'admin-whatsapp'),
  metrics: getMessages(locale, 'admin-metrics'),
  survey: getMessages(locale, 'admin-survey'),
  pass: getMessages(locale, 'admin-pass'),
  redemptions: getMessages(locale, 'admin-redemptions'),
  tshirts: getMessages(locale, 'admin-tshirts'),
  volunteers: getMessages(locale, 'admin-volunteers'),
});

/** The locals every administrator route passes. */
const adminPage = (
  { m }: Context,
  title: keyof MessagesOf['admin-shell'],
  navKey: string,
): Locals => ({
  layout: 'layouts/admin',
  title: (m.shell[title] as (v: { appTitle: string }) => string)({
    appTitle: env.appTitle,
  }),
  nodeEnv: env.nodeEnv,
  navKey,
});

const labelled = <V extends string>(
  values: readonly V[],
  labels: Record<V, string>,
): Record<V, string> =>
  Object.fromEntries(values.map((value) => [value, labels[value]])) as Record<
    V,
    string
  >;

const ATTENDEE = {
  attendeeId: '5f0c1f0e-2b6a-4a57-9a53-0d2f6a1b7c01',
  ticketCode: 'EV26-0001',
  name: 'Ana Souza',
  nickname: 'Aninha',
  role: 'participant',
  checkedIn: true,
  checkinNumber: 42,
  archived: false,
};

const LIMIT = {
  scope: 'total',
  cap: 500,
  mode: 'hard',
  used: 430,
  remaining: 70,
  status: 'near',
};

const DOOR = {
  unlocked: true,
  switchOn: true,
  availability: { available: true },
  spentUsd: 1.25,
  budgetUsd: 10,
  priceUsd: 0.0625,
};

const adminFilters = parseAttendeeFilters({ q: 'ana' });

const filterLabels = (shell: MessagesOf['admin-shell']) => ({
  roleFilters: {
    participant: shell.filterRoleParticipant(),
    all: shell.filterRoleAll(),
    volunteer: shell.filterRoleVolunteer(),
  },
  checkinFilters: {
    '': shell.filterCheckinAny(),
    yes: shell.filterCheckinYes(),
    no: shell.filterCheckinNo(),
  },
  archivedFilters: {
    '': shell.filterArchivedActive(),
    only: shell.filterArchivedOnly(),
    all: shell.filterArchivedAll(),
  },
});

const itemLabels = (chrome: MessagesOf['chrome']) => ({
  tshirt_volunteer: chrome.itemTshirtVolunteer(),
  lunch: chrome.itemLunch(),
  tshirt: chrome.itemTshirt(),
  meal: chrome.itemMeal(),
  drink: chrome.itemDrink(),
});

const attendeeItems = (chrome: MessagesOf['chrome']) => [
  {
    name: 'tshirtVolunteerSize',
    item: 'tshirt_volunteer',
    label: chrome.itemTshirtVolunteer(),
    value: null,
    redeemed: false,
    volunteerOnly: true,
  },
  {
    name: 'lunchOption',
    item: 'lunch',
    label: chrome.itemLunch(),
    value: null,
    redeemed: false,
    volunteerOnly: true,
  },
  {
    name: 'tshirtSize',
    item: 'tshirt',
    label: chrome.itemTshirt(),
    value: 'M',
    redeemed: true,
  },
  {
    name: 'mealOption',
    item: 'meal',
    label: chrome.itemMeal(),
    value: 'Vegetariano',
    redeemed: false,
  },
  {
    name: 'drinkOption',
    item: 'drink',
    label: chrome.itemDrink(),
    value: null,
    redeemed: false,
  },
];

const messagesOf = (
  { locale }: Context,
  namespaces: Parameters<typeof inlineCatalogs>[1],
) => inlineCatalogs(locale, namespaces);

/** The profile and pass the attendee pass is seeded with. */
const passData = (role: 'participant' | 'volunteer') => ({
  data: {
    profile: {
      attendeeRole: role,
      name: 'Ana Souza',
      nickname: 'Aninha',
      ticketCode: 'EV26-0001',
      checkinNumber: 42,
      team: role === 'volunteer' ? 'Recepção' : null,
      teamRole: role === 'volunteer' ? 'Líder' : null,
    },
    pass: {
      welcome: 'arrival',
      qr: 'data:image/png;base64,AAAA',
      band: null,
      survey: { open: false, completed: false },
    },
  },
});

const passPage = (
  ctx: Context,
  role: 'participant' | 'volunteer',
  survey = false,
): Locals => ({
  title: env.appTitle,
  nodeEnv: env.nodeEnv,
  audience: role,
  nicknamePattern: NICKNAME_INPUT_PATTERN,
  nicknameMinLength: NICKNAME_MIN_LENGTH,
  nicknameMaxLength: NICKNAME_MAX_LENGTH,
  bandEnabled: true,
  initialData: passData(role),
  messages: messagesOf(ctx, ['pass', 'chrome', 'survey']),
  copy: getCopy(ctx.locale, ['pass', 'survey']),
  survey: survey
    ? { audience: role, definition: surveyFor(role, ctx.locale), state: 'open' }
    : { audience: role, definition: null, state: 'hidden' },
});

const SURVEY_AUDIENCES = {
  participant: { enabled: true, hasQuestions: true, responses: 30 },
  volunteer: { enabled: true, hasQuestions: true, responses: 10 },
};

const ERROR_ACTION = { href: '/', label: 'Voltar ao início' };

export const CASES: ViewCase[] = [
  // Plain-layout notices and status pages.
  {
    name: 'privacy',
    view: 'pages/privacy',
    locals: ({ locale, chrome }) => ({
      layout: 'layouts/plain',
      title: chrome.titlePrivacy({ appTitle: env.appTitle }),
      notice: NOTICES[locale].privacy,
    }),
  },
  {
    name: 'terms',
    view: 'pages/terms',
    locals: ({ locale, chrome }) => ({
      layout: 'layouts/plain',
      title: chrome.titleTerms({ appTitle: env.appTitle }),
      notice: NOTICES[locale].terms,
    }),
  },
  {
    name: 'error-with-action',
    view: 'pages/error',
    locals: () => ({
      layout: 'layouts/plain',
      title: 'Página não encontrada',
      heading: '404',
      subtitle: 'Página não encontrada',
      message: 'O endereço pode ter mudado <ou> nunca ter existido.',
      action: ERROR_ACTION,
    }),
  },
  {
    name: 'error-without-action',
    view: 'pages/error',
    locals: () => ({
      layout: 'layouts/plain',
      title: 'Muitas tentativas',
      heading: '429',
      subtitle: 'Muitas tentativas',
      message: 'Aguarde um instante.',
      action: undefined,
    }),
  },
  {
    name: 'landing',
    view: 'pages/landing',
    locals: ({ locale }) =>
      landingView({
        opensAt: OPENS_AT,
        now: NOW,
        audience: 'participant',
        locale,
        timezone: env.landing.timezone,
        appTitle: env.appTitle,
        fallback: false,
      }),
  },
  {
    name: 'landing-fallback-reopening',
    view: 'pages/landing',
    locals: ({ locale }) =>
      landingView({
        opensAt: NOW - 1000,
        now: NOW,
        audience: 'volunteer',
        locale,
        timezone: env.landing.timezone,
        appTitle: env.appTitle,
        fallback: true,
      }),
  },
  {
    name: 'closing',
    view: 'pages/closing',
    locals: ({ locale }) => closingView({ locale, appTitle: env.appTitle }),
  },

  // Attendee pages, in the main layout unless noted.
  {
    name: 'checkin-continue',
    view: 'pages/attendee/checkin/continue',
    locals: ({ locale, chrome }) => ({
      layout: 'layouts/plain',
      title: chrome.titleCheckin({ appTitle: env.appTitle }),
      themeColor: '#fafafc',
      tokenField: 't',
      token: 'entry-token"><b>',
      audience: 'participant',
      copy: getCopy(locale, ['checkin']),
    }),
  },
  {
    name: 'checkin',
    view: 'pages/attendee/checkin/checkin',
    locals: (ctx) => ({
      title: ctx.chrome.titleCheckin({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      turnstileSiteKey: env.captcha.siteKey,
      audience: 'participant',
      ticketPattern: TICKET_INPUT_PATTERN,
      initialData: { success: true, data: { session: { step: 'ticket' } } },
      messages: messagesOf(ctx, ['checkin', 'qr']),
      copy: getCopy(ctx.locale, ['checkin', 'qr']),
    }),
  },
  {
    name: 'pass-participant',
    view: 'pages/attendee/participant/pass',
    locals: (ctx) => passPage(ctx, 'participant'),
  },
  {
    name: 'pass-volunteer',
    view: 'pages/attendee/volunteer/pass',
    locals: (ctx) => passPage(ctx, 'volunteer'),
  },
  {
    name: 'pass-participant-survey',
    view: 'pages/attendee/participant/pass',
    locals: (ctx) => passPage(ctx, 'participant', true),
  },
  {
    name: 'pass-volunteer-survey',
    view: 'pages/attendee/volunteer/pass',
    locals: (ctx) => passPage(ctx, 'volunteer', true),
  },
  {
    name: 'staff-scan',
    view: 'pages/attendee/staff/scan',
    locals: (ctx) => ({
      title: ctx.chrome.titleStaff({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      audience: 'volunteer',
      ticketPattern: TICKET_INPUT_PATTERN,
      bandEnabled: true,
      messages: messagesOf(ctx, ['staff', 'qr', 'chrome']),
      copy: getCopy(ctx.locale, ['staff', 'qr']),
    }),
  },
  {
    name: 'raffle-draw',
    view: 'pages/attendee/raffle/draw',
    locals: (ctx) => ({
      title: ctx.chrome.titleRaffle({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      audience: 'volunteer',
      messages: messagesOf(ctx, ['raffle']),
      copy: getCopy(ctx.locale, ['raffle']),
    }),
  },

  // Administrator pages.
  {
    name: 'admin-login',
    view: 'pages/admin/login',
    locals: (ctx) => ({
      layout: 'layouts/plain',
      title: ctx.m.login.title({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      copy: ctx.m.login,
      turnstileSiteKey: env.captchaAdmin.siteKey,
      messages: messagesOf(ctx, ['admin-login']),
    }),
  },
  {
    name: 'admin-home',
    view: 'pages/admin/home',
    admin: true,
    locals: (ctx) => adminPage(ctx, 'titleHome', 'home'),
  },
  {
    name: 'admin-attendees-list',
    view: 'pages/admin/attendees/list',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleAttendees', 'attendees'),
      copy: ctx.m.attendees,
      canWrite: true,
      door: DOOR,
      limit: LIMIT,
      canEditLimit: true,
      limitBounds: { min: 1, max: 10000 },
      messages: messagesOf(ctx, ['admin-attendees', 'admin-errors']),
      filters: adminFilters,
      total: 2,
      pageCount: 1,
      ...filterLabels(ctx.m.shell),
      attendees: [
        {
          ...ATTENDEE,
          phoneMasked: '(11) *****-1234',
          canRedeem: false,
          canDraw: false,
          items: attendeeItems(ctx.chrome).filter((i) => i.value !== null),
        },
        {
          ...ATTENDEE,
          attendeeId: '5f0c1f0e-2b6a-4a57-9a53-0d2f6a1b7c02',
          ticketCode: 'EV26-0002',
          name: 'Bruno <Lima>',
          nickname: null,
          role: 'volunteer',
          checkedIn: false,
          checkinNumber: null,
          archived: true,
          phoneMasked: '(21) *****-9876',
          canRedeem: true,
          canDraw: true,
          items: [],
        },
      ],
    }),
  },
  {
    name: 'admin-attendees-list-readonly',
    view: 'pages/admin/attendees/list',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleAttendees', 'attendees'),
      copy: ctx.m.attendees,
      canWrite: false,
      door: null,
      limit: null,
      canEditLimit: false,
      limitBounds: { min: 1, max: 10000 },
      messages: [],
      filters: adminFilters,
      total: 0,
      pageCount: 1,
      ...filterLabels(ctx.m.shell),
      attendees: [],
    }),
  },
  {
    name: 'admin-attendees-form-new',
    view: 'pages/admin/attendees/form',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleAttendeeNew', 'attendees'),
      copy: ctx.m.attendees,
      messages: messagesOf(ctx, ['admin-attendees', 'admin-errors']),
      attendee: null,
      itemOptions: ITEM_OPTIONS_BY_ROLE,
      canWrite: true,
      door: DOOR,
      limit: LIMIT,
      limitBlocked: false,
    }),
  },
  {
    name: 'admin-attendees-form-edit',
    view: 'pages/admin/attendees/form',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleAttendee', 'attendees'),
      copy: ctx.m.attendees,
      messages: messagesOf(ctx, ['admin-attendees', 'admin-errors']),
      canWrite: true,
      canMark: true,
      door: null,
      limit: null,
      limitBlocked: false,
      itemOptions: ITEM_OPTIONS_BY_ROLE,
      attendee: {
        ...ATTENDEE,
        phone: '+5511912341234',
        checkinAt: '17/10/2026 11:30',
        canRedeem: false,
        redeemScopes: [],
        canDraw: false,
        items: attendeeItems(ctx.chrome),
      },
    }),
  },
  {
    name: 'admin-lookup-search',
    view: 'pages/admin/lookup/search',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleLookup', 'lookup'),
      copy: ctx.m.lookup,
      canMark: true,
      filters: adminFilters,
      roleFilters: filterLabels(ctx.m.shell).roleFilters,
      searched: true,
      total: 1,
      pageCount: 1,
      results: [ATTENDEE],
    }),
  },
  {
    name: 'admin-lookup-detail',
    view: 'pages/admin/lookup/detail',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleLookup', 'lookup'),
      copy: ctx.m.lookup,
      messages: messagesOf(ctx, ['admin-lookup', 'admin-errors']),
      canMark: true,
      attendee: { ...ATTENDEE, verificationCode: '1234' },
    }),
  },
  {
    name: 'admin-metrics',
    view: 'pages/admin/metrics/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleMetrics', 'metrics'),
      copy: ctx.m.metrics,
      limitCopy: ctx.m.attendees,
      labels: metricsLabels(ctx.m.metrics),
      messages: messagesOf(ctx, ['admin-metrics', 'admin-attendees']),
      canSeeSurvey: false,
      surveyCoverage: null,
      timezone: env.landing.timezone,
      snapshot: {
        generatedAt: new Date(NOW).toISOString(),
        release: ctx.release,
        uptimeSeconds: 3600,
        windows: [
          {
            role: 'participant',
            opensAt: new Date(OPENS_AT).toISOString(),
            open: false,
          },
          { role: 'volunteer', opensAt: null, open: true },
        ],
        lastAlert: null,
        series: { 'checkin.complete': [0, 2, 5, 3] },
        limiters: [],
        fanout: [],
        latency: {
          checkin: { p50: 12, p95: 40, count: 10 },
          'api.checkin': { p50: null, p95: null, count: 0 },
        },
        health: {
          redis: { ok: true, durationMs: 2 },
          postgres: { ok: true, durationMs: 4 },
        },
        topErrors: [],
        redemptions: [],
        checkins: [
          { attendeeRole: 'participant', checkedIn: 120, expected: 400 },
          { attendeeRole: 'volunteer', checkedIn: 30, expected: 60 },
        ],
        checkinPrefixes: [],
        ticketLimit: LIMIT,
        survey: null,
      },
    }),
  },
  {
    name: 'admin-metrics-full',
    view: 'pages/admin/metrics/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleMetrics', 'metrics'),
      copy: ctx.m.metrics,
      limitCopy: ctx.m.attendees,
      labels: metricsLabels(ctx.m.metrics),
      messages: messagesOf(ctx, ['admin-metrics', 'admin-attendees']),
      canSeeSurvey: true,
      surveyCoverage: {
        total: 40,
        visible: true,
        rows: [
          { audience: 'participant', answered: 30, checkedIn: 120, off: false },
          { audience: 'volunteer', answered: 10, checkedIn: 30, off: false },
        ],
      },
      timezone: env.landing.timezone,
      snapshot: {
        generatedAt: new Date(NOW).toISOString(),
        release: ctx.release,
        uptimeSeconds: 7200,
        windows: [
          {
            role: 'participant',
            opensAt: new Date(NOW - 1000).toISOString(),
            open: true,
          },
          { role: 'volunteer', opensAt: null, open: true },
        ],
        lastAlert: { title: 'Fila de check-in <alta>' },
        series: {
          'checkin.complete': [1, 4, 9, 3],
          'severity.error': [0, 1, 0],
        },
        limiters: [
          {
            name: 'checkin-entry-ip',
            tier: 'strict',
            basis: null,
            keyedOn: 'ip',
            protects: 'checkin',
            ceiling: 30,
            duration: 60,
            peak: 27,
            refused: 3,
            topKeys: [{ key: '203.0.113.7', points: 27 }],
          },
        ],
        fanout: [{ ip: '203.0.113.7', sessions: 4 }],
        latency: {
          checkin: { p50: 12, p95: 40, count: 10 },
          'api.checkin': { p50: 30, p95: 90, count: 8 },
          staff: { p50: null, p95: null, count: 0 },
          'api.staff': { p50: 20, p95: 70, count: 5 },
        },
        health: {
          redis: { ok: true, durationMs: 2 },
          postgres: { ok: false, durationMs: 0, error: 'timeout' },
        },
        topErrors: [
          {
            fingerprint: 'ab12cd34',
            occurrences: 3,
            code: 'INTERNAL_ERROR',
            route: '/api/checkin',
            message: 'Falha <inesperada> & registrada',
          },
        ],
        redemptions: [
          { item: 'tshirt', outcome: 'redeemed', total: 12 },
          { item: 'lunch', outcome: 'redeemed', total: 7 },
        ],
        checkins: [
          { attendeeRole: 'participant', checkedIn: 120, expected: 400 },
          { attendeeRole: 'volunteer', checkedIn: 30, expected: 60 },
        ],
        checkinPrefixes: [{ prefix: 'EV26', checkedIn: 120, expected: 400 }],
        ticketLimit: LIMIT,
        survey: {
          state: { open: true, reason: 'schedule' },
          override: null,
          opensAt: NOW - 3600_000,
          closesAt: NOW + 3600_000,
          audiences: SURVEY_AUDIENCES,
        },
      },
    }),
  },
  {
    name: 'admin-whatsapp',
    view: 'pages/admin/whatsapp/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleWhatsapp', 'whatsapp'),
      copy: ctx.m.whatsapp,
      messages: messagesOf(ctx, ['admin-whatsapp', 'admin-errors']),
      templates: [
        {
          key: 'checkin_link',
          description: 'Link de entrada <teste>',
          priceUsd: 0.0625,
          roles: ['participant'],
          body: [
            { slot: '{{1}}', label: ctx.m.whatsapp.variableFirstName() },
            { slot: '{{2}}', label: ctx.m.whatsapp.variableTicketCode() },
          ],
          button: ctx.m.whatsapp.variableEntryLinkToken(),
        },
      ],
      audiences: {
        participant: ctx.m.whatsapp.audienceParticipant(),
        volunteer: ctx.m.whatsapp.audienceVolunteer(),
      },
      sendingEnabled: true,
      run: {
        runId: 'run-0001',
        status: 'running',
        total: 100,
        counts: { sent: 40, failed: 2 },
        spentUsd: 2.5,
        failures: [{ errorTitle: 'Número inválido', count: 2 }],
      },
    }),
  },
  {
    name: 'admin-whatsapp-idle',
    view: 'pages/admin/whatsapp/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleWhatsapp', 'whatsapp'),
      copy: ctx.m.whatsapp,
      messages: messagesOf(ctx, ['admin-whatsapp', 'admin-errors']),
      templates: [],
      audiences: {
        participant: ctx.m.whatsapp.audienceParticipant(),
        volunteer: ctx.m.whatsapp.audienceVolunteer(),
      },
      sendingEnabled: false,
      run: null,
    }),
  },
  {
    name: 'admin-survey',
    view: 'pages/admin/survey/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleSurvey', 'survey'),
      copy: ctx.m.survey,
      messages: messagesOf(ctx, ['admin-survey', 'admin-errors']),
      overview: {
        state: { open: true, reason: 'schedule' },
        override: null,
        opensAt: NOW - 3600_000,
        closesAt: NOW + 3600_000,
        audiences: SURVEY_AUDIENCES,
      },
      opensAt: '17/10/2026 10:30',
      closesAt: '17/10/2026 12:30',
      canOverride: true,
    }),
  },
  {
    name: 'admin-survey-closed',
    view: 'pages/admin/survey/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleSurvey', 'survey'),
      copy: ctx.m.survey,
      messages: messagesOf(ctx, ['admin-survey', 'admin-errors']),
      overview: {
        state: { open: false, reason: 'override' },
        override: 'closed',
        opensAt: null,
        closesAt: null,
        audiences: {
          participant: { enabled: false, hasQuestions: false, responses: 0 },
          volunteer: { enabled: true, hasQuestions: true, responses: 3 },
        },
      },
      opensAt: null,
      closesAt: null,
      canOverride: false,
    }),
  },
  {
    name: 'admin-pass',
    view: 'pages/admin/pass/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titlePass', 'pass'),
      copy: ctx.m.pass,
      messages: messagesOf(ctx, ['admin-pass', 'admin-errors']),
      timeZone: env.landing.timezone,
      source: 'saved',
      revision: 3,
      current: ctx.m.pass.phaseArrival(),
      next: { phase: ctx.m.pass.phaseSurvey(), at: '17/10/2026 15:00' },
      phases: [
        {
          value: 'arrival',
          label: ctx.m.pass.phaseArrival(),
          text: 'Bem-vindo',
        },
        { value: 'thanks', label: ctx.m.pass.phaseThanks(), text: 'Obrigado' },
      ],
      custom: { value: 'custom', label: ctx.m.pass.phaseCustom() },
      textMaxLength: 80,
      defaults: [{ phase: ctx.m.pass.phaseArrival(), at: '17/10/2026 08:00' }],
      rows: [
        { phase: 'arrival', text: '', at: '2026-10-17T08:00' },
        { phase: 'custom', text: 'Bom <evento>', at: '2026-10-17T15:00' },
      ],
    }),
  },
  {
    name: 'admin-redemptions-index',
    view: 'pages/admin/redemptions/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleRedemptions', 'redemptions'),
      copy: ctx.m.redemptions,
      messages: messagesOf(ctx, ['admin-redemptions']),
      timezone: env.landing.timezone,
      itemLabels: labelled(REDEMPTION_ITEM_ORDER, itemLabels(ctx.chrome)),
      statusFilters: labelled(REDEMPTION_STATUS_FILTERS, {
        pending: ctx.m.redemptions.filterStatusPending(),
        redeemed: ctx.m.redemptions.filterStatusRedeemed(),
        all: ctx.m.redemptions.filterStatusAll(),
      }),
      checkinFilters: filterLabels(ctx.m.shell).checkinFilters,
      filters: parseRedemptionFilters({ item: 'tshirt', status: 'pending' }),
      total: 1,
      pageCount: 1,
      summary: {
        updatedAt: '11:30',
        items: [
          {
            item: 'tshirt',
            label: ctx.chrome.itemTshirt(),
            share: 50,
            progress: ctx.m.redemptions.summaryProgress({ share: 50 }),
            options: [],
          },
        ],
      },
      rows: [
        {
          attendeeId: ATTENDEE.attendeeId,
          name: ATTENDEE.name,
          nickname: ATTENDEE.nickname,
          ticketCode: ATTENDEE.ticketCode,
          role: ATTENDEE.role,
          checkedIn: true,
          checkinNumber: 42,
          option: 'M',
          redeemedAt: null,
        },
      ],
    }),
  },
  {
    name: 'admin-redemptions-detail',
    view: 'pages/admin/redemptions/detail',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleRedemptions', 'redemptions'),
      copy: ctx.m.redemptions,
      messages: messagesOf(ctx, ['admin-redemptions', 'admin-errors']),
      canCorrect: true,
      canEdit: true,
      attendee: ATTENDEE,
      items: [
        {
          item: 'tshirt',
          label: ctx.chrome.itemTshirt(),
          option: 'M',
          redeemedAt: new Date(NOW - 60_000).toISOString(),
          redeemedAtText: '17/10/2026 11:29',
        },
        {
          item: 'meal',
          label: ctx.chrome.itemMeal(),
          option: 'Vegetariano',
          redeemedAt: null,
          redeemedAtText: '',
        },
      ],
      reasons: {
        mark: REASONS_FOR.mark.map((value) => ({ value, label: value })),
        revert: REASONS_FOR.revert.map((value) => ({ value, label: value })),
      },
      history: [
        {
          when: '17/10/2026 11:29',
          item: ctx.chrome.itemTshirt(),
          outcome: 'redeemed',
          outcomeLabel: 'Entregue',
          reason: null,
          by: 'operadora',
        },
      ],
      historyLimit: 200,
      historyTruncated: false,
    }),
  },
  {
    name: 'admin-tshirts-search',
    view: 'pages/admin/tshirts/search',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleTshirts', 'tshirts'),
      copy: ctx.m.tshirts,
      statusFilters: labelled(REDEMPTION_STATUS_FILTERS, {
        pending: ctx.m.tshirts.searchStatusPending(),
        redeemed: ctx.m.tshirts.searchStatusRedeemed(),
        all: ctx.m.tshirts.searchStatusAll(),
      }),
      filters: { ...adminFilters, status: 'all' },
      searched: true,
      total: 1,
      pageCount: 1,
      results: [{ ...ATTENDEE, size: 'M', redeemedAt: null }],
    }),
  },
  {
    name: 'admin-tshirts-detail',
    view: 'pages/admin/tshirts/detail',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleTshirts', 'tshirts'),
      copy: ctx.m.tshirts,
      messages: messagesOf(ctx, ['admin-tshirts', 'admin-errors']),
      attendee: {
        ...ATTENDEE,
        size: 'M',
        redeemedAt: null,
        redeemedAtText: '',
        verificationCode: '1234',
      },
    }),
  },
  {
    name: 'admin-volunteers-index',
    view: 'pages/admin/volunteers/index',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleVolunteers', 'volunteers'),
      copy: ctx.m.volunteers,
      messages: messagesOf(ctx, ['admin-volunteers']),
      rows: [
        {
          attendeeId: ATTENDEE.attendeeId,
          name: 'Carla Maia',
          nickname: null,
          ticketCode: 'EV26-0100',
          tier: 'none',
          tierLabel: ctx.m.volunteers.tier({ tier: 'none' }),
          team: null,
          teamRole: null,
          stations: [],
          canDraw: false,
          showAdminLink: false,
        },
      ],
      legend: [
        {
          value: 'none',
          label: ctx.m.volunteers.tier({ tier: 'none' }),
          access: ctx.m.volunteers.legendAccess({ tier: 'none' }),
          grant: ctx.m.volunteers.legendGrant({ tier: 'none' }),
        },
      ],
      tiers: [
        {
          value: 'none',
          label: ctx.m.volunteers.tier({ tier: 'none' }),
          count: 1,
        },
      ],
      teams: [],
      hasUnteamed: true,
    }),
  },
  {
    name: 'admin-volunteers-detail',
    view: 'pages/admin/volunteers/detail',
    admin: true,
    locals: (ctx) => ({
      ...adminPage(ctx, 'titleVolunteers', 'volunteers'),
      copy: ctx.m.volunteers,
      messages: messagesOf(ctx, ['admin-volunteers', 'admin-errors']),
      volunteer: {
        attendeeId: ATTENDEE.attendeeId,
        name: 'Carla Maia',
        nickname: 'Cacá',
        ticketCode: 'EV26-0100',
        canRedeem: true,
        redeemScopes: ['lunch'],
        canDraw: false,
        showAdminLink: false,
        team: 'Recepção',
        teamRole: 'Líder',
        checkinTime: '08:00',
        adminUsername: null,
        adminDisabled: false,
        tier: 'none',
        tierLabel: ctx.m.volunteers.tier({ tier: 'none' }),
      },
      stations: [
        { item: 'lunch', label: ctx.chrome.itemLunch() },
        { item: 'tshirt', label: ctx.chrome.itemTshirt() },
      ],
      history: [
        {
          when: '17/10/2026 09:00',
          by: 'operadora',
          diffs: [{ field: 'team', before: '—', after: 'Recepção' }],
        },
      ],
      labelMaxLength: 40,
    }),
  },
];

/**
 * Cases only the demo build renders; the snapshot suite does not assert them.
 *
 * `not-found` is the 404 with plain copy, where `error-with-action` carries an
 * escaping test string.
 */
export const DEMO_CASES: ViewCase[] = [
  {
    name: 'not-found',
    view: 'pages/error',
    locals: () => ({
      layout: 'layouts/plain',
      title: 'Página não encontrada',
      heading: '404',
      subtitle: 'Página não encontrada',
      message: 'O endereço pode ter mudado ou nunca ter existido.',
      action: ERROR_ACTION,
    }),
  },
];
