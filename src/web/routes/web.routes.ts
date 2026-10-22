import express from 'express';

import type { Request, RequestHandler, Response } from 'express';

import type { MessagesOf } from '../../i18n/generated/registry.ts';
import type { Locale } from '../../i18n/locales.ts';
import type { AttendeeRole } from '../../types/attendee.ts';
import type { RedemptionItem, WelcomePhase } from '../../constants/pass.ts';
import type { WelcomeLine } from '../../config/pass-welcome.ts';
import type { RedemptionCorrectionReason } from '../../constants/redemptions.ts';
import type { TicketLimitOverview } from '../../types/ticket-limit.ts';

import { env } from '../../config/env.ts';
import { dateTimeLocale } from '../../i18n/locales.ts';
import { surveyCoverage } from '../../constants/survey-coverage.ts';
import { redisOutageToUnavailable } from '../../middleware/redis-outage.middleware.ts';
import { normaliseBodyParserError } from '../../middleware/body-parser-error.middleware.ts';
import {
  getCopy,
  getMessages,
  inlineCatalogs,
  localeMiddleware,
} from '../../i18n/server.ts';

import { adminPage } from './admin-page.ts';
import { checkinEntry, checkinEntryPost } from './checkin-entry.ts';
import { NOTICES } from '../content/notices.ts';
import { siteManifest } from '../content/site-manifest.ts';
import { metricsLabels } from '../../modules/metrics/metrics.labels.ts';
import { buildSnapshot } from '../../modules/metrics/metrics.service.ts';
import {
  resolveSessions,
  requireWebAuth,
  requireNoSession,
} from '../../middleware/auth.middleware.ts';
import {
  attendeeSessionLimiter,
  checkinEntryIpLimiter,
  webLimiter,
} from '../../middleware/rate.middleware.ts';
import {
  requireDrawPermissionWeb,
  requireRedeemPermissionWeb,
} from '../../middleware/permission.middleware.ts';

import {
  NotFoundError,
  ValidationError,
} from '../../shared/errors/app-error.ts';
import { AttendeeService } from '../../modules/attendee/attendee.service.ts';
import { surveyFor } from '../../modules/survey/survey.definition.ts';
import { ITEM_OPTIONS_BY_ROLE } from '../../modules/admin/admin.item-options.ts';
import { surveyAudienceEnabled } from '../../modules/survey/survey.window.ts';
import {
  SurveyAdminService,
  isAudience,
} from '../../modules/survey/survey.admin.ts';
import { PassAdminService } from '../../modules/pass/pass.admin.ts';
import { instantToWallTime } from '../../shared/utils/zoned-time.ts';
import {
  WELCOME_CUSTOM_PHASE,
  WELCOME_PHASES,
  WELCOME_TEXT_MAX_LENGTH,
} from '../../constants/pass.ts';
import { TICKET_INPUT_PATTERN } from '../../constants/ticket.ts';
import {
  NICKNAME_INPUT_PATTERN,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MIN_LENGTH,
} from '../../constants/nickname.ts';
import { toAudienceRole } from '../../constants/audience.ts';
import {
  ARCHIVED_FILTERS,
  CHECKIN_FILTERS,
  PAGE_SIZE,
  ROLE_FILTERS,
  parseAttendeeFilters,
} from '../../constants/attendee-filters.ts';
import {
  getAttendeeForEdit,
  listAttendees,
} from '../../modules/admin/admin.attendees.repository.ts';
import {
  ITEM_COLUMNS,
  listRedemptionRoster,
  redemptionHistory,
} from '../../modules/admin/admin.redemptions.repository.ts';
import { buildRedemptionSummary } from '../../modules/admin/admin.redemptions.service.ts';
import { LABEL_MAX_LENGTH } from '../../modules/admin/admin.attendees.rules.ts';
import { ITEM_ORDER } from '../../modules/admin/admin.volunteer-permissions.import.ts';
import { AdminVolunteersService } from '../../modules/admin/admin.volunteers.service.ts';
import { ACCESS_TIERS } from '../../constants/access-tier.ts';
import {
  REASONS_FOR,
  REDEMPTION_HISTORY_LIMIT,
  REDEMPTION_ITEM_ORDER,
  REDEMPTION_STATUS_FILTERS,
  parseRedemptionFilters,
} from '../../constants/redemptions.ts';
import { AdminWhatsappDoorService } from '../../modules/admin/admin.whatsapp-door.service.ts';
import { AdminTicketLimitService } from '../../modules/admin/admin.ticket-limit.service.ts';
import {
  countsTowards,
  wouldRefuse,
} from '../../modules/admin/admin.ticket-limit.rules.ts';
import {
  TICKET_LIMIT_CAP_MAX,
  TICKET_LIMIT_CAP_MIN,
} from '../../constants/ticket-limit.ts';
import { AdminWhatsappService } from '../../modules/admin/admin.whatsapp.service.ts';
import { describeFailure } from '../../modules/whatsapp/whatsapp.run-codes.ts';
import {
  TEMPLATE_PRICE_USD,
  WHATSAPP_TEMPLATES,
  type TemplateVariable,
  type WhatsappTemplate,
  type WhatsappTemplateKey,
} from '../../constants/whatsapp-templates.ts';
import { maskPhone, verificationCodeOf } from '../../shared/utils/mask.ts';
import { isUuid } from '../../shared/utils/uuid.ts';
import {
  closingGate,
  landingGate,
} from '../../middleware/landing.middleware.ts';
import { noStore } from '../../middleware/no-store.middleware.ts';
import { rejectNulInput } from '../../middleware/reject-nul.middleware.ts';
import { requireSameOrigin } from '../../middleware/same-origin.middleware.ts';

const router = express.Router();

/**
 * The admin catalogs in the locale a response renders in. `getMessages` is
 * memoised, so this costs a few map reads per request.
 *
 * @param res - The response being rendered.
 */
const adminMessages = (res: Response) => {
  const { locale } = res.locals;

  return {
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
  };
};

/**
 * The ticket limit as the record form's banner shows it, or `null` for no
 * banner.
 *
 * Advisory only: the create and the restore check again, so a failed read, or a
 * limit that is off, hides the banner rather than the form, which must keep
 * working for the queue at the door.
 *
 * @param req - The request, for the service's session.
 */
const readLimitForForm = (req: Request): Promise<TicketLimitOverview | null> =>
  new AdminTicketLimitService(req)
    .overview()
    .then((overview) => (overview.status === 'off' ? null : overview))
    .catch((err: unknown) => {
      req.log.error({ err }, 'Ticket limit overview failed');

      return null;
    });

/**
 * Pairs each filter value with its label, in the order the constant lists
 * them: the filter controls render `Object.entries` of the result.
 *
 * @param values - The filter's values.
 * @param labels - A label for every value.
 */
const labelled = <V extends string>(
  values: readonly V[],
  labels: Record<V, string>,
): Record<V, string> =>
  Object.fromEntries(values.map((value) => [value, labels[value]])) as Record<
    V,
    string
  >;

/**
 * The roster and lookup filter controls' labels.
 *
 * @param shell - `admin-shell` in the response's locale.
 */
const filterLabels = (shell: MessagesOf['admin-shell']) => ({
  roleFilters: labelled(ROLE_FILTERS, {
    participant: shell.filterRoleParticipant(),
    all: shell.filterRoleAll(),
    volunteer: shell.filterRoleVolunteer(),
  }),
  checkinFilters: labelled(CHECKIN_FILTERS, {
    '': shell.filterCheckinAny(),
    yes: shell.filterCheckinYes(),
    no: shell.filterCheckinNo(),
  }),
  archivedFilters: labelled(ARCHIVED_FILTERS, {
    '': shell.filterArchivedActive(),
    only: shell.filterArchivedOnly(),
    all: shell.filterArchivedAll(),
  }),
});

/**
 * What the questionnaire's chip and dialog render from.
 *
 * An enabled audience always gets both, with the chip hidden until the window
 * opens, so the pass poll can reveal it without a reload. A switched-off
 * audience gets neither, and the poll can never show a chip the page did not
 * render.
 *
 * @param role - The attendee's role.
 * @param locale - The response's locale.
 * @param state - The questionnaire's state from the pass just issued.
 */
const surveyView = (
  role: AttendeeRole,
  locale: Locale,
  state: { open: boolean; completed: boolean },
) => ({
  audience: role,
  definition: surveyAudienceEnabled(role) ? surveyFor(role, locale) : null,
  state: state.completed ? 'done' : state.open ? 'open' : 'hidden',
});

router.use(webLimiter);

// Ahead of every route, the manifest included: each of them renders or
// answers in the resolved locale. Behind the limiter, so a `?lang=` redirect
// is charged like any other request.
router.use(localeMiddleware);

// After the locale, so the refusal renders in it. Covers every query string on
// this router; `formBody` covers the posted bodies.
router.use(rejectNulInput);

// Served from a bare layout rather than layouts/main: that one renders a
// full-viewport boot screen only JavaScript removes, and hides <main> under
// <noscript>. A privacy notice has to be readable without either, and the same
// goes for the terms.
router.get('/privacy', (_req, res) => {
  res.render('pages/privacy', {
    layout: 'layouts/plain',
    title: res.locals.chrome.titlePrivacy({ appTitle: env.appTitle }),
    notice: NOTICES[res.locals.locale].privacy,
  });
});

router.get('/terms', (_req, res) => {
  res.render('pages/terms', {
    layout: 'layouts/plain',
    title: res.locals.chrome.titleTerms({ appTitle: env.appTitle }),
    notice: NOTICES[res.locals.locale].terms,
  });
});

// A route rather than a static file so the installed app's name stays tied to
// APP_TITLE, which every page title here already reads. Deliberately above
// resolveSessions and landingGate: the manifest is fetched in the background,
// where no gate's redirect or sign-in can be followed. The layouts link it with
// `crossorigin="use-credentials"` so the fetch carries `cf_clearance` past the
// edge's site-wide challenge, which it otherwise answers with a 403.
router.get('/site.webmanifest', (_req, res) => {
  res
    .type('application/manifest+json')
    .json(siteManifest(env.appTitle, res.locals.locale));
});

// Above resolveSessions: after the event no gated page needs a session, so
// looking one up would be Redis work for a page that never reads it.
router.use(closingGate);

router.use(resolveSessions);

// Below resolveSessions so an attendee who already checked in is recognised,
// and above every route so a gated request never reaches one — /checkin's
// checkinEntryIpLimiter included. /privacy and /terms sit above both and are
// untouched.
router.use(landingGate);

router.get(
  '/checkin',
  noStore,
  checkinEntryIpLimiter,
  requireNoSession('attendee', '/'),
  checkinEntry(),
);

/**
 * The administrator sign-in page.
 *
 * Rendered through `layouts/plain` rather than `layouts/main`: that layout
 * paints a full-viewport boot screen only JavaScript removes and hides `<main>`
 * under `<noscript>`. A sign-in form has to work without either.
 *
 * `requireNoSession` means an administrator who is already signed in and taps a
 * bookmark lands on the pass instead of a form asking who they are.
 *
 * `noStore` is spelled out here rather than inherited: this is the one
 * administrator page that does not go through `adminPage()`, and it carries a
 * credential form rather than attendee data. The reason is the same either way
 * — nothing on this surface belongs in a store on the operator's own device.
 */
router.get(
  '/admin/login',
  noStore,
  requireNoSession('admin', '/admin'),
  (_req, res) => {
    const m = adminMessages(res);

    res.render('pages/admin/login', {
      layout: 'layouts/plain',
      title: m.login.title({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      copy: m.login,
      // The admin widget, not the attendee one: a separate key with its own
      // hostname allowlist, because this form answers on two hostnames.
      turnstileSiteKey: env.captchaAdmin.siteKey,
      messages: inlineCatalogs(res.locals.locale, ['admin-login']),
    });
  },
);

/**
 * The administrator surface.
 *
 * `adminPage(null)`: no scope gate, deliberately. Holding a session is what
 * this page requires, and it renders only what the caller may see, because
 * `adminChrome` filters the navigation to the sections they hold a scope for.
 * Screens that act on data pass their own scope instead.
 *
 * **The plug-in contract every screen copies** lives in `adminPage()` — see
 * `routes/admin-page.ts`, which owns the middleware and the order it has to run
 * in. Each route still spells out its own view, title and `navKey`, because
 * those are the parts that differ.
 *
 * `navKey` matches the entry's `key` in `constants/admin-nav.ts` and is what
 * marks it `aria-current` in the rail. `/admin` passes `home`, which matches no
 * entry — the arrival screen is not a section, since it has no scope to gate on.
 */
router.get('/admin', ...adminPage(null), (_req, res) => {
  const m = adminMessages(res);

  res.render('pages/admin/home', {
    layout: 'layouts/admin',
    title: m.shell.titleHome({ appTitle: env.appTitle }),
    nodeEnv: env.nodeEnv,
    navKey: 'home',
  });
});

/**
 * What every administrator form posts through.
 *
 * **No attendee value travels in a URL on this surface** — not the roster's
 * filters, not a search term, not an attendee ID. A URL is written to the
 * browser's history, and a history entry outlives the session, the tailnet
 * grant and the account itself; on a phone signed into a browser account it is
 * also synced off the device. The volunteer lookup is read on personal phones,
 * which is what makes that unacceptable rather than untidy.
 * `docs/security/data-retention.md` records the rule and what it costs.
 *
 * `express.urlencoded` is mounted here rather than on the app: these and the
 * check-in continue form are the only HTML form posts in the application, and
 * `api/index.ts` deliberately mounts `express.json` alone. `extended: false` because every one of these
 * forms is flat.
 *
 * None of them change state, so `requireSameOrigin` is consistency rather than
 * a control — but a `POST` route with no origin check is a gap somebody finds
 * later and cannot explain.
 */
const formBody: RequestHandler[] = [
  requireSameOrigin,
  express.urlencoded({ extended: false, limit: '1kb', inflate: false }),
  rejectNulInput,
];

/**
 * The entry a visitor confirms on the continue page.
 *
 * `GET /checkin` writes no session for a navigation that comes from another
 * site; it asks the visitor to tap, and that tap posts the token here from this
 * origin. `requireSameOrigin` is the control: a form on another site posts with
 * its own `Origin` and is refused. The entry limiter keeps charging every
 * attempt, and the failure budgets live in the service.
 */
router.post(
  '/checkin',
  noStore,
  ...formBody,
  checkinEntryIpLimiter,
  requireNoSession('attendee', '/'),
  checkinEntryPost(),
);

/**
 * Reads an attendee ID out of a submitted form.
 *
 * A `GET` reaches these routes with no body at all — Express 5 leaves
 * `req.body` undefined until a parser runs — so a stale bookmark or a history
 * entry from before this change lands here with nothing and is redirected,
 * which is the same answer a malformed ID has always received.
 *
 * @param body - `req.body`, which may be undefined.
 * @returns The ID, or an empty string, which never passes `isUuid`.
 */
const readAttendeeId = (body: unknown): string => {
  if (typeof body !== 'object' || body === null) return '';

  const { attendeeId } = body as Record<string, unknown>;

  return typeof attendeeId === 'string' ? attendeeId : '';
};

/**
 * The attendee roster.
 *
 * Gated on `attendees:read` rather than `attendees:write`: an operator who may
 * look at the roster and not change it is a real account — the volunteer
 * lookup's shape — and they get the table with no controls on it. The API
 * refuses them independently, so hiding the buttons is courtesy rather than
 * enforcement.
 *
 * Filters, search and paging are submitted as a form and every one of them is
 * a full page load, so the whole screen works with JavaScript off and costs
 * `webLimiter` rather than `adminSessionLimiter`.
 *
 * **One handler, two verbs.** A `GET` arrives before any body parser has run,
 * so `parseAttendeeFilters` sees nothing and answers with the cleared state —
 * which is exactly what `/admin/attendees` should mean, and what the "Limpar"
 * control has always linked to. A `POST` carries the filters. Nothing branches
 * on the method, so the two cannot drift.
 *
 * The rows are mapped to a view model here rather than in the template. A
 * template that reaches for `maskPhone` is a template that has to be tested
 * like code, and `.ejs` is outside every automated gate this repository has.
 */
const renderRoster: RequestHandler = async (req, res, next) => {
  try {
    const filters = parseAttendeeFilters(req.body);

    const { rows, total } = await listAttendees(filters);

    const scopes = res.locals.adminScopes ?? [];

    // The door message panel, for whoever may flip it. A failed read hides the
    // panel rather than the roster.
    const door = scopes.includes('whatsapp:send')
      ? await new AdminWhatsappDoorService(req)
          .overview()
          .catch((err: unknown) => {
            req.log.error({ err }, 'Door message overview failed');

            return null;
          })
      : null;

    // The ticket limit status, for every roster viewer; `attendees:limit` only
    // decides who may edit it. A failed read hides the panel rather than the
    // roster.
    const canEditLimit = scopes.includes('attendees:limit');
    const overview = await new AdminTicketLimitService(req)
      .overview()
      .catch((err: unknown) => {
        req.log.error({ err }, 'Ticket limit overview failed');

        return null;
      });

    // A read-only viewer has nothing to see while the limit is off; an editor
    // always does, to be able to switch it on.
    const limit =
      overview !== null && (canEditLimit || overview.status !== 'off')
        ? overview
        : null;

    const m = adminMessages(res);

    res.render('pages/admin/attendees/list', {
      layout: 'layouts/admin',
      title: m.shell.titleAttendees({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      navKey: 'attendees',
      copy: m.attendees,

      canWrite: scopes.includes('attendees:write'),
      door,
      limit,
      canEditLimit,
      limitBounds: { min: TICKET_LIMIT_CAP_MIN, max: TICKET_LIMIT_CAP_MAX },
      // Only the panels' scripts read a catalog.
      messages:
        door || limit
          ? inlineCatalogs(res.locals.locale, [
              'admin-attendees',
              'admin-errors',
            ])
          : [],
      filters,
      total,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
      ...filterLabels(m.shell),

      attendees: rows.map((row) => ({
        attendeeId: row.attendee_id,
        ticketCode: row.ticket_code,
        name: row.attendee_name,
        nickname: row.attendee_nickname,

        // Masked, deliberately. The roster is the screen left open on a desk
        // in a room with people in it; the edit form is where a mistyped
        // number actually gets fixed, and it shows the whole thing.
        phoneMasked: maskPhone(row.attendee_phone),

        role: row.attendee_role,
        checkedIn: row.checkin_complete,
        checkinNumber: row.checkin_number,
        archived: row.archived_at !== null,
        canRedeem: row.can_redeem,
        canDraw: row.can_draw,

        items: [
          {
            label: res.locals.chrome.itemTshirtVolunteer(),
            value: row.tshirt_volunteer_size,
            redeemed: row.tshirt_volunteer_redeemed_at !== null,
          },
          {
            label: res.locals.chrome.itemLunch(),
            value: row.lunch_option,
            redeemed: row.lunch_redeemed_at !== null,
          },
          {
            label: res.locals.chrome.itemTshirt(),
            value: row.tshirt_size,
            redeemed: row.tshirt_redeemed_at !== null,
          },
          {
            label: res.locals.chrome.itemMeal(),
            value: row.meal_option,
            redeemed: row.meal_redeemed_at !== null,
          },
          {
            label: res.locals.chrome.itemDrink(),
            value: row.drink_option,
            redeemed: row.drink_redeemed_at !== null,
          },
        ].filter((item) => item.value !== null),
      })),
    });
  } catch (err) {
    next(err);
  }
};

/**
 * The live panel.
 *
 * Renders a complete snapshot server-side rather than an empty shell the bundle
 * fills in. That is the hard rule on this surface — the rail already works with
 * JavaScript off and a screen that did not would be the first exception — and it
 * is also what makes the page useful on a laptop whose bundle failed to load at
 * exactly the moment somebody needed to know why.
 *
 * `buildSnapshot` is the same function the API endpoint serves, so the first
 * paint and the first poll cannot disagree about what a panel means. It degrades
 * per panel rather than throwing, so a Redis outage renders a page with empty
 * Redis panels — which is itself the diagnosis — instead of a 500.
 */
router.get(
  '/admin/metrics',
  ...adminPage('metrics:read'),
  async (_req, res, next) => {
    try {
      const m = adminMessages(res);

      // The questionnaire card needs `export:read` on top of `metrics:read`:
      // without it the counts are not read, and the card is not rendered.
      const canSeeSurvey =
        res.locals.adminScopes?.includes('export:read') === true;
      const snapshot = await buildSnapshot({ survey: canSeeSurvey });

      res.render('pages/admin/metrics/index', {
        layout: 'layouts/admin',
        title: m.shell.titleMetrics({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'metrics',
        copy: m.metrics,
        // The ticket limit block reuses the roster's meter and its strings.
        limitCopy: m.attendees,
        labels: metricsLabels(m.metrics),
        messages: inlineCatalogs(res.locals.locale, [
          'admin-metrics',
          'admin-attendees',
        ]),
        canSeeSurvey,
        surveyCoverage: snapshot.survey
          ? surveyCoverage(snapshot.survey, snapshot.checkins)
          : null,
        timezone: env.landing.timezone,
        snapshot,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The WhatsApp sender.
 *
 * **One handler, two verbs**, like {@link renderRoster}. Nothing on this screen
 * is submitted for the server to act on — every action is a JSON call from the
 * page script — so the `POST` exists for one reason: every form here carries
 * `method="post"`, which is what stops an uncancelled submit putting a typed
 * phone number into a URL. See `mask.ts` on the sign-in form that did.
 *
 * The first paint carries the current run, so the screen is honest with
 * JavaScript off: it shows what the run was doing when the page was rendered,
 * rather than an empty frame that never fills.
 *
 * The view model is built here rather than in the template, following the
 * roster: a template that reaches into the registry is a template that has to
 * be tested like code.
 *
 * The variable map is what the operator checks against WhatsApp Manager. It
 * lists the slots in order rather than a rendered message, because the registry
 * holds the order and not the approved body text — and the order is the part
 * that silently fails, as a `132000`.
 */
/**
 * Audiences a run may be aimed at.
 *
 * Its own list rather than `ROLE_FILTERS`, which carries an `all` option the
 * roster needs and this screen must not offer: a run is enqueued for one
 * `attendee_role`, and `isAudienceRole` refuses anything else. Reusing that
 * constant would put a choice on screen the API answers with a 400.
 *
 * @param whatsapp - `admin-whatsapp` in the response's locale.
 */
const senderAudiences = (whatsapp: MessagesOf['admin-whatsapp']) => ({
  participant: whatsapp.audienceParticipant(),
  volunteer: whatsapp.audienceVolunteer(),
});

/**
 * Each template variable's label. Total, like `TEMPLATE_RESOLVERS`.
 *
 * @param whatsapp - `admin-whatsapp` in the response's locale.
 */
const variableLabels = (
  whatsapp: MessagesOf['admin-whatsapp'],
): Record<TemplateVariable, string> => ({
  firstName: whatsapp.variableFirstName(),
  ticketCode: whatsapp.variableTicketCode(),
  entryLinkToken: whatsapp.variableEntryLinkToken(),
  team: whatsapp.variableTeam(),
  checkinTime: whatsapp.variableCheckinTime(),
  lunchOption: whatsapp.variableLunchOption(),
});

const renderSender: RequestHandler = async (req, res, next) => {
  try {
    const service = new AdminWhatsappService(req);

    // Read through the interface rather than the `as const` literal. The
    // literal type makes `urlButton` non-optional while the registry holds one
    // entry that happens to have one, which would make the check below read as
    // dead code — and stop being true the moment a template without a button is
    // added.
    const registry: Record<WhatsappTemplateKey, WhatsappTemplate> =
      WHATSAPP_TEMPLATES;

    const m = adminMessages(res);
    const labelOf = variableLabels(m.whatsapp);

    const templates = (
      Object.entries(registry) as [WhatsappTemplateKey, WhatsappTemplate][]
    ).map(([key, template]) => ({
      key,
      description: template.description,
      priceUsd: TEMPLATE_PRICE_USD[template.category],
      roles: [...template.roles],
      body: template.body.map((variable, index) => ({
        slot: `{{${String(index + 1)}}}`,
        label: labelOf[variable],
      })),
      button: template.urlButton ? labelOf[template.urlButton.variable] : null,
    }));

    const run = await service.currentRun();

    res.render('pages/admin/whatsapp/index', {
      layout: 'layouts/admin',
      title: m.shell.titleWhatsapp({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      navKey: 'whatsapp',
      copy: m.whatsapp,
      messages: inlineCatalogs(res.locals.locale, [
        'admin-whatsapp',
        'admin-errors',
      ]),

      templates,
      audiences: senderAudiences(m.whatsapp),
      sendingEnabled: env.whatsapp.enabled,
      run: run && {
        ...run,
        failures: run.failures.map((failure) => ({
          ...failure,
          errorTitle: describeFailure(m.whatsapp, failure.errorTitle),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
};

router.get('/admin/whatsapp', ...adminPage('whatsapp:send'), renderSender);
router.post(
  '/admin/whatsapp',
  ...adminPage('whatsapp:send'),
  ...formBody,
  renderSender,
);

/**
 * The questionnaire's control room: state, switches, counts, the override and
 * the downloads.
 *
 * Gated on `export:read`, the lower of the questionnaire's two scopes: whoever
 * may take the answers away may see the state and counts. The override control
 * is drawn only for `survey:write`, which its API enforces again, so an
 * administrator who runs the questionnaire needs both.
 */
router.get(
  '/admin/survey',
  ...adminPage('export:read'),
  async (req, res, next) => {
    try {
      const m = adminMessages(res);
      const overview = await new SurveyAdminService(req).overview();

      const when = new Intl.DateTimeFormat(dateTimeLocale(res.locals.locale), {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone: env.landing.timezone,
      });

      res.render('pages/admin/survey/index', {
        layout: 'layouts/admin',
        title: m.shell.titleSurvey({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'survey',
        copy: m.survey,
        messages: inlineCatalogs(res.locals.locale, [
          'admin-survey',
          'admin-errors',
        ]),

        overview,
        opensAt:
          overview.opensAt === null ? null : when.format(overview.opensAt),
        closesAt:
          overview.closesAt === null ? null : when.format(overview.closesAt),
        canOverride: res.locals.adminScopes?.includes('survey:write') === true,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * One audience's answers as CSV.
 *
 * A page route rather than an API one: it is a plain link the browser follows
 * with its cookie, so it needs no script, and a lapsed session is sent to sign
 * in like any other page. The query picks a file, not a person, so it keeps to
 * the rule that no attendee value travels in an admin URL.
 */
router.get(
  '/admin/survey/export.csv',
  ...adminPage('export:read'),
  async (req, res, next) => {
    try {
      const { audience } = req.query;

      if (!isAudience(audience)) throw new ValidationError('Invalid audience');

      const csv = await new SurveyAdminService(req).exportCsv(audience);

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="survey-${audience}.csv"`,
      );

      res.send(csv);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The pass's welcome schedule: which one passes follow, the `.env` default,
 * and the editor that supersedes it.
 *
 * Every instant is handed to the view twice over: as the event zone's wall
 * time, which is what the editor's `datetime-local` inputs hold and send back,
 * and formatted for reading. Neither depends on the administrator's device.
 */
router.get(
  '/admin/pass',
  ...adminPage('pass:write'),
  async (req, res, next) => {
    try {
      const m = adminMessages(res);
      const passCopy = getMessages(res.locals.locale, 'pass');
      const overview = await new PassAdminService(req).overview();
      const timeZone = env.landing.timezone;

      const when = new Intl.DateTimeFormat(dateTimeLocale(res.locals.locale), {
        dateStyle: 'short',
        timeStyle: 'short',
        timeZone,
      });

      const PHASE_LABELS: Record<WelcomePhase, string> = {
        arrival: m.pass.phaseArrival(),
        default: m.pass.phaseDefault(),
        survey: m.pass.phaseSurvey(),
        thanks: m.pass.phaseThanks(),
      };

      const label = (line: WelcomeLine): string =>
        line.phase === WELCOME_CUSTOM_PHASE
          ? m.pass.customLabel({ text: line.text })
          : PHASE_LABELS[line.phase];

      res.render('pages/admin/pass/index', {
        layout: 'layouts/admin',
        title: m.shell.titlePass({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'pass',
        copy: m.pass,
        messages: inlineCatalogs(res.locals.locale, [
          'admin-pass',
          'admin-errors',
        ]),

        timeZone,
        source: overview.source,
        revision: overview.revision,
        current: label(overview.current),
        next:
          overview.next === null
            ? null
            : {
                phase: label(overview.next),
                at: when.format(overview.next.at),
              },
        phases: WELCOME_PHASES.map((phase) => ({
          value: phase,
          label: PHASE_LABELS[phase],
          text: passCopy.welcome({ phase }),
        })),
        custom: { value: WELCOME_CUSTOM_PHASE, label: m.pass.phaseCustom() },
        textMaxLength: WELCOME_TEXT_MAX_LENGTH,
        defaults: overview.defaults.map((entry) => ({
          phase: label(entry),
          at: when.format(entry.at),
        })),
        rows: (overview.saved ?? overview.defaults).map((entry) => ({
          phase: entry.phase,
          text: entry.phase === WELCOME_CUSTOM_PHASE ? entry.text : '',
          at: instantToWallTime(entry.at, timeZone),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

router.get('/admin/attendees', ...adminPage('attendees:read'), renderRoster);
router.post(
  '/admin/attendees',
  ...adminPage('attendees:read'),
  ...formBody,
  renderRoster,
);

/**
 * The blank record form.
 *
 * Gated on `attendees:read`, like the roster. The API refuses a read-only
 * operator on every write independently, so opening the form is not the thing
 * worth gating.
 */
router.get(
  '/admin/attendees/new',
  ...adminPage('attendees:read'),
  async (req, res) => {
    const canWrite = (res.locals.adminScopes ?? []).includes('attendees:write');

    // The WhatsApp checkbox's starting state. Advisory only — the create checks
    // again — so a failed read hides the checkbox rather than the form, which
    // must keep working for the queue at the door.
    const door = canWrite
      ? await new AdminWhatsappDoorService(req)
          .availability()
          .catch((err: unknown) => {
            req.log.error({ err }, 'Door message availability failed');

            return null;
          })
      : null;

    const limit = canWrite ? await readLimitForForm(req) : null;

    const m = adminMessages(res);

    res.render('pages/admin/attendees/form', {
      layout: 'layouts/admin',
      title: m.shell.titleAttendeeNew({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      navKey: 'attendees',
      copy: m.attendees,
      messages: inlineCatalogs(res.locals.locale, [
        'admin-attendees',
        'admin-errors',
      ]),

      attendee: null,
      itemOptions: ITEM_OPTIONS_BY_ROLE,
      canWrite,
      door,
      limit,
      // The blank form opens on a participant with a generated code, which is
      // what counts in every scope; the script recomputes as the fields change.
      limitBlocked: limit !== null && wouldRefuse(limit, limit.scope !== 'off'),
    });
  },
);

/**
 * One attendee's record.
 *
 * **Reached by a form post, not a link.** The ID rides in the body for the
 * reason `formBody` gives: a URL is written to the browser's history, and an
 * attendee ID is still a fact about a person. The roster's edit control is a
 * submit button pointed at this route.
 *
 * A missing ID, a malformed one or a missing row all redirect to the roster
 * rather than rendering an error, matching `/staff` and `/raffle`: a bookmarked
 * link going quiet is not a fault worth a stack of red.
 *
 * The title deliberately does **not** name the attendee. A history entry stores
 * the title alongside the URL, so `Participante` is what keeps a name off the
 * device once the ID has left the path.
 *
 * Unlike the roster, this shows the **whole** phone number. It is the screen
 * where a mistyped one gets corrected, and correcting what you cannot read is
 * not a thing anybody can do.
 */
router.post(
  '/admin/attendees/edit',
  ...adminPage('attendees:read'),
  ...formBody,
  async (req, res, next) => {
    try {
      const attendeeId = readAttendeeId(req.body);

      if (!isUuid(attendeeId)) return res.redirect('/admin/attendees');

      const row = await getAttendeeForEdit(attendeeId);

      if (!row) return res.redirect('/admin/attendees');

      const scopes = res.locals.adminScopes ?? [];
      const canWrite = scopes.includes('attendees:write');

      // As on the blank form: advisory, and a failed read hides the checkbox
      // rather than the record.
      const door =
        canWrite && row.archived_at === null
          ? await new AdminWhatsappDoorService(req)
              .availability()
              .catch((err: unknown) => {
                req.log.error({ err }, 'Door message availability failed');

                return null;
              })
          : null;

      // Only an archived record has a restore to count; elsewhere the limit is
      // not this page's business.
      const limit =
        canWrite && row.archived_at !== null
          ? await readLimitForForm(req)
          : null;

      const m = adminMessages(res);

      res.render('pages/admin/attendees/form', {
        layout: 'layouts/admin',
        title: m.shell.titleAttendee({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'attendees',
        copy: m.attendees,
        messages: inlineCatalogs(res.locals.locale, [
          'admin-attendees',
          'admin-errors',
        ]),

        canWrite,
        canMark: scopes.includes('checkin:write'),
        door,
        limit,
        limitBlocked:
          limit !== null &&
          wouldRefuse(
            limit,
            countsTowards(limit.scope, row.attendee_role, row.ticket_code),
          ),
        itemOptions: ITEM_OPTIONS_BY_ROLE,
        attendee: {
          attendeeId: row.attendee_id,
          ticketCode: row.ticket_code,
          name: row.attendee_name,
          nickname: row.attendee_nickname,
          phone: row.attendee_phone,
          role: row.attendee_role,
          checkedIn: row.checkin_complete,
          checkinNumber: row.checkin_number,
          checkinAt:
            row.checkin_at === null
              ? null
              : eventClock(res.locals.locale, 'dateTime').format(
                  row.checkin_at,
                ),
          archived: row.archived_at !== null,
          canRedeem: row.can_redeem,
          redeemScopes: row.redeem_scopes,
          canDraw: row.can_draw,
          // Resolved against `itemOptions` by the template, which needs both
          // roles' lists to offer the other role's on a role change.
          items: [
            {
              name: 'tshirtVolunteerSize',
              item: 'tshirt_volunteer',
              label: res.locals.chrome.itemTshirtVolunteer(),
              value: row.tshirt_volunteer_size,
              redeemed: row.tshirt_volunteer_redeemed_at !== null,
              volunteerOnly: true,
            },
            {
              name: 'lunchOption',
              item: 'lunch',
              label: res.locals.chrome.itemLunch(),
              value: row.lunch_option,
              redeemed: row.lunch_redeemed_at !== null,
              volunteerOnly: true,
            },
            {
              name: 'tshirtSize',
              item: 'tshirt',
              label: res.locals.chrome.itemTshirt(),
              value: row.tshirt_size,
              redeemed: row.tshirt_redeemed_at !== null,
            },
            {
              name: 'mealOption',
              item: 'meal',
              label: res.locals.chrome.itemMeal(),
              value: row.meal_option,
              redeemed: row.meal_redeemed_at !== null,
            },
            {
              name: 'drinkOption',
              item: 'drink',
              label: res.locals.chrome.itemDrink(),
              value: row.drink_option,
              redeemed: row.drink_redeemed_at !== null,
            },
          ],
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * What is left of the record's old address.
 *
 * `/admin/attendees/<uuid>` was a link until the attendee ID moved into the
 * body, and it survives in bookmarks and in browser histories written before
 * that change. Redirecting is how those degrade; a 404 would read as the record
 * being gone.
 *
 * **Registered after `/new`**, and the order is load-bearing: Express matches in
 * registration order, so the other way round `new` would be read as an attendee
 * ID and redirected to the roster — a silent wrong answer rather than the blank
 * form.
 */
router.get(
  '/admin/attendees/:attendeeId',
  ...adminPage('attendees:read'),
  (_req, res) => {
    res.redirect('/admin/attendees');
  },
);

/**
 * The volunteer quick lookup.
 *
 * Gated on `attendees:read` like the roster, and read-only in itself — the one
 * privileged action lives behind `checkin:write` on the API, so an operator
 * holding only read reaches this screen and finds no button.
 *
 * **Two of the roster's three filters are pinned; `role` is parsed.** The two
 * are pinned for different reasons and only one of them is negotiable. Hiding
 * archived rows is a correctness requirement: an archived attendee cannot check
 * in, so finding one would offer a button that answers 409, and a submitted
 * `archived=only` must not be able to change that. `checkedIn` is pinned for
 * simplicity — a volunteer at a door searches a name, not a presence state.
 *
 * `role` reaches the query because the screen now carries a control for it,
 * defaulting to participants. `parseAttendeeFilters` is still doing the work it
 * is good at either way — the accent folding, the wildcard escaping, the
 * phone-digit guard and the page clamp.
 *
 * **One handler, two verbs**, like the roster: a `GET` reaches it before any
 * body parser has run, so the term is empty and the prompt renders. A volunteer
 * opening this on a phone should get a prompt, not the roster — and now that is
 * what the bare URL means rather than something the handler decides.
 */
const renderLookup: RequestHandler = async (req, res, next) => {
  try {
    const filters = {
      ...parseAttendeeFilters(req.body),
      checkedIn: null,
      archived: 'hidden' as const,
    };

    const searched = filters.q !== '';

    const { rows, total } = searched
      ? await listAttendees(filters)
      : { rows: [], total: 0 };

    const scopes = res.locals.adminScopes ?? [];

    const m = adminMessages(res);

    res.render('pages/admin/lookup/search', {
      layout: 'layouts/admin',
      title: m.shell.titleLookup({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      navKey: 'lookup',
      copy: m.lookup,

      canMark: scopes.includes('checkin:write'),
      filters,
      roleFilters: filterLabels(m.shell).roleFilters,
      searched,
      total,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),

      // No phone here, masked or otherwise, and the omission is the point: the
      // verification code is the last four digits, and this screen is the one
      // that may show several people at once. The record page shows it, alone.
      results: rows.map((row) => ({
        attendeeId: row.attendee_id,
        ticketCode: row.ticket_code,
        name: row.attendee_name,
        nickname: row.attendee_nickname,
        role: row.attendee_role,
        checkedIn: row.checkin_complete,
        checkinNumber: row.checkin_number,
      })),
    });
  } catch (err) {
    next(err);
  }
};

router.get('/admin/lookup', ...adminPage('attendees:read'), renderLookup);
router.post(
  '/admin/lookup',
  ...adminPage('attendees:read'),
  ...formBody,
  renderLookup,
);

/**
 * One attendee, and the only page in this application that renders a
 * verification code.
 *
 * `attendees:read` like the search — the API refuses a read-only operator
 * independently, so the gate here is about opening the screen rather than about
 * the button on it.
 *
 * **Reached by a form post, not a link.** The ID rides in the body for the
 * reason `formBody` gives, and the title says `Consulta` rather than the
 * attendee's name because a history entry stores the title too. Between them,
 * a volunteer's phone records that the lookup was used and nothing about who
 * it was used on.
 *
 * A missing ID, a malformed one and a missing row all redirect rather than
 * erroring, matching `/staff`, `/raffle` and the editor: a bookmarked link
 * going quiet is not a fault worth a stack of red.
 *
 * **`verificationCodeOf` is called here, not in the template.** It returns a
 * shared secret and `.ejs` is outside every automated gate this repository has,
 * so the one place it is read should be code that type-checks. The full phone
 * still never reaches the view model — only the four digits do.
 */
router.post(
  '/admin/lookup/record',
  ...adminPage('attendees:read'),
  ...formBody,
  async (req, res, next) => {
    try {
      const attendeeId = readAttendeeId(req.body);

      if (!isUuid(attendeeId)) return res.redirect('/admin/lookup');

      const row = await getAttendeeForEdit(attendeeId);

      if (!row) return res.redirect('/admin/lookup');

      const scopes = res.locals.adminScopes ?? [];

      const m = adminMessages(res);

      res.render('pages/admin/lookup/detail', {
        layout: 'layouts/admin',
        title: m.shell.titleLookup({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'lookup',
        copy: m.lookup,
        messages: inlineCatalogs(res.locals.locale, [
          'admin-lookup',
          'admin-errors',
        ]),

        canMark: scopes.includes('checkin:write'),

        attendee: {
          attendeeId: row.attendee_id,
          name: row.attendee_name,
          nickname: row.attendee_nickname,
          ticketCode: row.ticket_code,
          role: row.attendee_role,
          checkedIn: row.checkin_complete,
          checkinNumber: row.checkin_number,
          archived: row.archived_at !== null,
          verificationCode: verificationCodeOf(row.attendee_phone),
        },
      });

      return;
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Every item's display name, from `chrome.item.*`.
 *
 * @param chrome - `chrome` in the response's locale.
 */
const itemLabelsOf = (
  chrome: MessagesOf['chrome'],
): Record<RedemptionItem, string> => ({
  tshirt_volunteer: chrome.itemTshirtVolunteer(),
  lunch: chrome.itemLunch(),
  tshirt: chrome.itemTshirt(),
  meal: chrome.itemMeal(),
  drink: chrome.itemDrink(),
});

/**
 * Every correction reason's label, from `admin-redemptions.reason.*`.
 *
 * @param copy - `admin-redemptions` in the response's locale.
 */
const reasonLabelsOf = (
  copy: MessagesOf['admin-redemptions'],
): Record<RedemptionCorrectionReason, string> => ({
  mis_tap: copy.reasonMisTap(),
  wrong_attendee: copy.reasonWrongAttendee(),
  offline: copy.reasonOffline(),
  other: copy.reasonOther(),
});

/**
 * Formats a moment as the event's clock shows it.
 *
 * @param locale - The response's locale.
 * @param style - `dateTime` for a record's timestamps, `time` for the
 *   summary's last refresh.
 */
const eventClock = (locale: string, style: 'dateTime' | 'time') =>
  new Intl.DateTimeFormat(dateTimeLocale(locale), {
    ...(style === 'dateTime'
      ? { dateStyle: 'short', timeStyle: 'short' }
      : { timeStyle: 'medium' }),
    timeZone: env.landing.timezone,
  } as const);

/**
 * The redemptions screen: per-item totals, and who is entitled to one item.
 *
 * Gated on `redemptions:read`. Corrections are made from the record page and
 * refused by the API without `redemptions:write`, so this screen has no
 * control that needs the second scope.
 *
 * **One handler, two verbs**, as the roster is: a `GET` has no body and renders
 * the defaults, a `POST` carries the filters, and nothing branches on the
 * method. The totals come from `buildRedemptionSummary`, the function the poll
 * endpoint serves, so the first paint and the first refresh agree.
 */
const renderRedemptions: RequestHandler = async (req, res, next) => {
  try {
    const filters = parseRedemptionFilters(req.body);

    const [summary, { rows, total }] = await Promise.all([
      buildRedemptionSummary(),
      listRedemptionRoster(filters),
    ]);

    const m = adminMessages(res);
    const { locale } = res.locals;
    const labels = itemLabelsOf(res.locals.chrome);
    const when = eventClock(locale, 'dateTime');

    res.render('pages/admin/redemptions/index', {
      layout: 'layouts/admin',
      title: m.shell.titleRedemptions({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      navKey: 'redemptions',
      copy: m.redemptions,
      messages: inlineCatalogs(locale, ['admin-redemptions']),
      timezone: env.landing.timezone,

      itemLabels: labelled(REDEMPTION_ITEM_ORDER, labels),
      statusFilters: labelled(REDEMPTION_STATUS_FILTERS, {
        pending: m.redemptions.filterStatusPending(),
        redeemed: m.redemptions.filterStatusRedeemed(),
        all: m.redemptions.filterStatusAll(),
      }),
      checkinFilters: filterLabels(m.shell).checkinFilters,

      filters,
      total,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),

      summary: {
        updatedAt: eventClock(locale, 'time').format(summary.generatedAt),
        items: summary.items.map((entry) => ({
          ...entry,
          label: labels[entry.item],
          progress:
            entry.share === null
              ? ''
              : m.redemptions.summaryProgress({ share: entry.share }),
        })),
      },

      rows: rows.map((row) => ({
        attendeeId: row.attendee_id,
        name: row.attendee_name,
        nickname: row.attendee_nickname,
        ticketCode: row.ticket_code,
        role: row.attendee_role,
        checkedIn: row.checkin_complete,
        checkinNumber: row.checkin_number,
        option: row.option,
        redeemedAt: row.redeemed_at ? when.format(row.redeemed_at) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

router.get(
  '/admin/redemptions',
  ...adminPage('redemptions:read'),
  renderRedemptions,
);
router.post(
  '/admin/redemptions',
  ...adminPage('redemptions:read'),
  ...formBody,
  renderRedemptions,
);

/**
 * One attendee's redemptions, their corrections and their history.
 *
 * **Reached by a form post, not a link**, and titled without the attendee's
 * name, for the reasons `/admin/lookup/record` gives. A missing, malformed or
 * unknown ID redirects to the screen rather than erroring, as it does there.
 *
 * `getAttendeeForEdit` includes archived records, so an archived attendee's
 * history stays readable; the corrections are withheld from one, and the API
 * refuses them on its own.
 *
 * Each collection time is rendered twice: formatted for reading, and as the
 * exact ISO string an undo sends back. The second is what lets the server
 * refuse an undo of a collection this page never showed.
 */
router.post(
  '/admin/redemptions/record',
  ...adminPage('redemptions:read'),
  ...formBody,
  async (req, res, next) => {
    try {
      const attendeeId = readAttendeeId(req.body);

      if (!isUuid(attendeeId)) return res.redirect('/admin/redemptions');

      const row = await getAttendeeForEdit(attendeeId);

      if (!row) return res.redirect('/admin/redemptions');

      const history = await redemptionHistory(attendeeId);

      const scopes = res.locals.adminScopes ?? [];
      const archived = row.archived_at !== null;

      const m = adminMessages(res);
      const labels = itemLabelsOf(res.locals.chrome);
      const reasonLabels = reasonLabelsOf(m.redemptions);
      const when = eventClock(res.locals.locale, 'dateTime');

      res.render('pages/admin/redemptions/detail', {
        layout: 'layouts/admin',
        title: m.shell.titleRedemptions({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'redemptions',
        copy: m.redemptions,
        messages: inlineCatalogs(res.locals.locale, [
          'admin-redemptions',
          'admin-errors',
        ]),

        canCorrect: scopes.includes('redemptions:write') && !archived,
        canEdit: scopes.includes('attendees:read'),

        attendee: {
          attendeeId: row.attendee_id,
          name: row.attendee_name,
          nickname: row.attendee_nickname,
          ticketCode: row.ticket_code,
          role: row.attendee_role,
          checkedIn: row.checkin_complete,
          checkinNumber: row.checkin_number,
          archived,
        },

        items: REDEMPTION_ITEM_ORDER.flatMap((item) => {
          const option = row[ITEM_COLUMNS[item].option];
          const redeemedAt = row[ITEM_COLUMNS[item].redeemedAt];

          return option === null
            ? []
            : [
                {
                  item,
                  label: labels[item],
                  option,
                  redeemedAt: redeemedAt?.toISOString() ?? null,
                  redeemedAtText: redeemedAt ? when.format(redeemedAt) : '',
                },
              ];
        }),

        reasons: {
          mark: REASONS_FOR.mark.map((value) => ({
            value,
            label: reasonLabels[value],
          })),
          revert: REASONS_FOR.revert.map((value) => ({
            value,
            label: reasonLabels[value],
          })),
        },

        history: history.map((entry) => ({
          when: when.format(entry.created_at),
          item: labels[entry.item],
          outcome: entry.outcome,
          outcomeLabel: m.redemptions.historyOutcomeLabel({
            outcome: entry.outcome,
          }),
          by:
            entry.actor_name ??
            m.redemptions.historyUnknownActor({ kind: entry.actor_type }),
          actorKind: m.redemptions.historyActorKind({
            kind: entry.actor_type,
          }),
          reason: entry.reason ? reasonLabels[entry.reason] : null,
        })),

        truncatedAt:
          history.length >= REDEMPTION_HISTORY_LIMIT
            ? REDEMPTION_HISTORY_LIMIT
            : null,
      });

      return;
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The t-shirt desk: finding somebody entitled to a shirt, to hand it over.
 *
 * Gated on `tshirt:redeem`, the one scope that opens this screen and permits
 * the write behind it, so an operator holding only that reaches no other
 * attendee screen.
 *
 * **`item` and `checkedIn` are pinned, not parsed.** The desk is about one item
 * — a submitted `item=meal` must not turn it into a general redemptions list
 * that a narrower scope could browse — and a shirt is handed over whether or
 * not the attendee has checked in. `parseRedemptionFilters` still does what it
 * is good at: the status fallback (pending here), the accent folding, the
 * wildcard escaping, the phone-digit guard and the page clamp. Archived
 * attendees are never listed.
 *
 * **One handler, two verbs**, like the lookup: a `GET` has no body, so the term
 * is empty and the prompt renders rather than the whole roster.
 */
const renderTshirts: RequestHandler = async (req, res, next) => {
  try {
    const filters = {
      ...parseRedemptionFilters(req.body, 'pending'),
      item: 'tshirt' as const,
      checkedIn: null,
    };

    const searched = filters.q !== '';

    const { rows, total } = searched
      ? await listRedemptionRoster(filters)
      : { rows: [], total: 0 };

    const m = adminMessages(res);
    const when = eventClock(res.locals.locale, 'dateTime');

    res.render('pages/admin/tshirts/search', {
      layout: 'layouts/admin',
      title: m.shell.titleTshirts({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      navKey: 'tshirts',
      copy: m.tshirts,

      statusFilters: labelled(REDEMPTION_STATUS_FILTERS, {
        pending: m.tshirts.searchStatusPending(),
        redeemed: m.tshirts.searchStatusRedeemed(),
        all: m.tshirts.searchStatusAll(),
      }),
      filters,
      searched,
      total,
      pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),

      // No phone here, masked or otherwise, and no verification code: the
      // roster query does not select the phone, and the code is the last four
      // digits of it. The record page shows the code, for one person.
      results: rows.map((row) => ({
        attendeeId: row.attendee_id,
        ticketCode: row.ticket_code,
        name: row.attendee_name,
        nickname: row.attendee_nickname,
        role: row.attendee_role,
        checkedIn: row.checkin_complete,
        checkinNumber: row.checkin_number,
        size: row.option,
        redeemedAt: row.redeemed_at ? when.format(row.redeemed_at) : null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

router.get('/admin/tshirts', ...adminPage('tshirt:redeem'), renderTshirts);
router.post(
  '/admin/tshirts',
  ...adminPage('tshirt:redeem'),
  ...formBody,
  renderTshirts,
);

/**
 * One attendee at the t-shirt desk: their size, whether it was collected, and
 * the verification code the person at the desk checks before handing it over.
 *
 * **Reached by a form post, not a link**, and titled without the attendee's
 * name, for the reasons `/admin/lookup/record` gives. A missing, malformed or
 * unknown ID, or an attendee with no shirt on the order, redirects to the
 * search rather than erroring.
 *
 * An archived attendee still renders, flagged, and the view offers no
 * hand-over for one; the API refuses it on its own.
 *
 * **`verificationCodeOf` is called here, not in the template**, for the reason
 * `/admin/lookup/record` gives. The full phone never reaches the view model.
 */
router.post(
  '/admin/tshirts/record',
  ...adminPage('tshirt:redeem'),
  ...formBody,
  async (req, res, next) => {
    try {
      const attendeeId = readAttendeeId(req.body);

      if (!isUuid(attendeeId)) return res.redirect('/admin/tshirts');

      const row = await getAttendeeForEdit(attendeeId);

      if (!row?.tshirt_size) return res.redirect('/admin/tshirts');

      const m = adminMessages(res);
      const when = eventClock(res.locals.locale, 'dateTime');
      const redeemedAt = row.tshirt_redeemed_at;

      res.render('pages/admin/tshirts/detail', {
        layout: 'layouts/admin',
        title: m.shell.titleTshirts({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'tshirts',
        copy: m.tshirts,
        messages: inlineCatalogs(res.locals.locale, [
          'admin-tshirts',
          'admin-errors',
        ]),

        attendee: {
          attendeeId: row.attendee_id,
          name: row.attendee_name,
          nickname: row.attendee_nickname,
          ticketCode: row.ticket_code,
          role: row.attendee_role,
          checkedIn: row.checkin_complete,
          checkinNumber: row.checkin_number,
          archived: row.archived_at !== null,
          size: row.tshirt_size,
          redeemedAt: redeemedAt?.toISOString() ?? null,
          redeemedAtText: redeemedAt ? when.format(redeemedAt) : '',
          verificationCode: verificationCodeOf(row.attendee_phone),
        },
      });

      return;
    } catch (err) {
      next(err);
    }
  },
);

/**
 * The volunteer permissions screen: every volunteer with their access, the
 * legend of what each access means, and the controls to filter them.
 *
 * Gated on `volunteers:write`, the scope the API that saves them enforces: the
 * screen is an editor, and has no read-only form. Filtering is the bundle's, over
 * the rows rendered here, so the list is the whole roster in one response and
 * nothing about the filters reaches a URL or a query.
 */
router.get(
  '/admin/volunteers',
  ...adminPage('volunteers:write'),
  async (req, res, next) => {
    try {
      const volunteers = await new AdminVolunteersService(req).list();

      const m = adminMessages(res);
      const { locale } = res.locals;
      const labels = itemLabelsOf(res.locals.chrome);

      const rows = volunteers.map((volunteer) => {
        const tier = volunteer.tier ?? 'none';

        return {
          attendeeId: volunteer.attendeeId,
          name: volunteer.name,
          nickname: volunteer.nickname,
          ticketCode: volunteer.ticketCode,
          tier,
          tierLabel: m.volunteers.tier({ tier }),
          team: volunteer.team,
          teamRole: volunteer.teamRole,
          stations: volunteer.canRedeem
            ? volunteer.redeemScopes.map((item) => labels[item])
            : [],
          canDraw: volunteer.canDraw,
          showAdminLink: volunteer.showAdminLink,
        };
      });

      const tiers = ACCESS_TIERS.flatMap((value) => {
        const count = rows.filter((row) => row.tier === value).length;

        return count === 0
          ? []
          : [{ value, label: m.volunteers.tier({ tier: value }), count }];
      });

      const legend = ACCESS_TIERS.map((value) => ({
        value,
        label: m.volunteers.tier({ tier: value }),
        access: m.volunteers.legendAccess({ tier: value }),
        grant: m.volunteers.legendGrant({ tier: value }),
      }));

      const teams = [
        ...new Set(rows.flatMap((row) => (row.team ? [row.team] : []))),
      ].sort((a, b) => a.localeCompare(b, locale));

      res.render('pages/admin/volunteers/index', {
        layout: 'layouts/admin',
        title: m.shell.titleVolunteers({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'volunteers',
        copy: m.volunteers,
        messages: inlineCatalogs(locale, ['admin-volunteers']),

        rows,
        legend,
        tiers,
        teams,
        hasUnteamed: rows.some((row) => !row.team),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * One volunteer's permissions, and the changes made to them.
 *
 * **Reached by a form post, not a link**, and titled without the volunteer's
 * name, for the reasons `/admin/lookup/record` gives. A missing, malformed or
 * unknown ID redirects to the list rather than erroring, as the other records
 * do.
 *
 * Each history entry carries only the fields that differ between its two
 * snapshots, with stations compared as sets.
 */
router.post(
  '/admin/volunteers/record',
  ...adminPage('volunteers:write'),
  ...formBody,
  async (req, res, next) => {
    try {
      const attendeeId = readAttendeeId(req.body);

      if (!isUuid(attendeeId)) return res.redirect('/admin/volunteers');

      let volunteer;

      try {
        volunteer = await new AdminVolunteersService(req).get(attendeeId);
      } catch (err) {
        if (err instanceof NotFoundError) {
          return res.redirect('/admin/volunteers');
        }

        throw err;
      }

      const m = adminMessages(res);
      const { locale } = res.locals;
      const labels = itemLabelsOf(res.locals.chrome);
      const when = eventClock(locale, 'dateTime');
      const tier = volunteer.tier ?? 'none';

      const text = (value: string | null) => value ?? '';
      const stationsText = (items: RedemptionItem[]) =>
        ITEM_ORDER.filter((item) => items.includes(item))
          .map((item) => labels[item])
          .join(', ');
      const flagText = (value: boolean) =>
        value ? m.volunteers.historyYes() : m.volunteers.historyNo();

      const history = volunteer.changes.map((change) => {
        const { before, after } = change;
        const diffs: { field: string; before: string; after: string }[] = [];

        const add = (
          field: Parameters<typeof m.volunteers.historyField>[0]['field'],
          from: string,
          to: string,
        ) => {
          diffs.push({
            field: m.volunteers.historyField({ field }),
            before: from,
            after: to,
          });
        };

        if (before.can_redeem !== after.can_redeem) {
          add(
            'canRedeem',
            flagText(before.can_redeem),
            flagText(after.can_redeem),
          );
        }

        if (
          before.redeem_scopes.length !== after.redeem_scopes.length ||
          before.redeem_scopes.some(
            (item) => !after.redeem_scopes.includes(item),
          )
        ) {
          add(
            'redeemScopes',
            stationsText(before.redeem_scopes),
            stationsText(after.redeem_scopes),
          );
        }

        if (before.can_draw !== after.can_draw) {
          add('canDraw', flagText(before.can_draw), flagText(after.can_draw));
        }

        if (before.show_admin_link !== after.show_admin_link) {
          add(
            'showAdminLink',
            flagText(before.show_admin_link),
            flagText(after.show_admin_link),
          );
        }

        if (before.team !== after.team) {
          add('team', text(before.team), text(after.team));
        }

        if (before.team_role !== after.team_role) {
          add('teamRole', text(before.team_role), text(after.team_role));
        }

        if (before.checkin_time !== after.checkin_time) {
          add(
            'checkinTime',
            text(before.checkin_time),
            text(after.checkin_time),
          );
        }

        return {
          when: when.format(change.changedAt),
          by: change.changedBy ?? m.volunteers.historyRemovedAdmin(),
          diffs,
        };
      });

      res.render('pages/admin/volunteers/detail', {
        layout: 'layouts/admin',
        title: m.shell.titleVolunteers({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        navKey: 'volunteers',
        copy: m.volunteers,
        messages: inlineCatalogs(locale, ['admin-volunteers', 'admin-errors']),

        volunteer: {
          attendeeId: volunteer.attendeeId,
          name: volunteer.name,
          nickname: volunteer.nickname,
          ticketCode: volunteer.ticketCode,
          canRedeem: volunteer.canRedeem,
          redeemScopes: volunteer.redeemScopes,
          canDraw: volunteer.canDraw,
          showAdminLink: volunteer.showAdminLink,
          team: volunteer.team,
          teamRole: volunteer.teamRole,
          checkinTime: volunteer.checkinTime,
          adminUsername: volunteer.adminUsername,
          adminDisabled: volunteer.adminDisabled,
          tier,
          tierLabel: m.volunteers.tier({ tier }),
        },
        stations: ITEM_ORDER.map((item) => ({ item, label: labels[item] })),
        history,
        labelMaxLength: LABEL_MAX_LENGTH,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * What is left of the record's old address, as on the roster.
 *
 * `/admin/lookup/<uuid>` was a link until the attendee ID moved into the body,
 * and it survives wherever a volunteer's phone wrote it down before that
 * change. Redirecting is how those degrade.
 */
router.get(
  '/admin/lookup/:attendeeId',
  ...adminPage('attendees:read'),
  (_req, res) => {
    res.redirect('/admin/lookup');
  },
);

router.get(
  ['/', '/pass'],
  noStore,
  requireWebAuth('attendee', '/checkin'),
  attendeeSessionLimiter,
  async (req, res, next) => {
    try {
      const service = new AttendeeService({ req, res });
      const profile = await service.getProfile();

      if (!profile) throw new NotFoundError('Attendee profile not found');

      const pass = await service.issuePass();

      const payload = {
        title: env.appTitle,
        nodeEnv: env.nodeEnv,
        audience: toAudienceRole(req.query.audience),
        // Sourced from the same constant as the server validator and the
        // browser guard, so the three cannot drift apart.
        nicknamePattern: NICKNAME_INPUT_PATTERN,
        nicknameMinLength: NICKNAME_MIN_LENGTH,
        nicknameMaxLength: NICKNAME_MAX_LENGTH,
        bandEnabled: env.passBandEnabled,
        // The rotating half is seeded here rather than left to the page's first
        // poll. Without it the pass paints with an empty QR box and no band for
        // as long as a request takes — on the one screen an attendee opens with
        // a volunteer already looking at it.
        initialData: { data: { profile, pass } },
        messages: inlineCatalogs(res.locals.locale, [
          'pass',
          'chrome',
          'survey',
        ]),
        copy: getCopy(res.locals.locale, ['pass', 'survey']),
        survey: surveyView(
          profile.attendeeRole,
          res.locals.locale,
          pass.survey,
        ),
      };

      switch (profile.attendeeRole) {
        case 'participant': {
          res.render('pages/attendee/participant/pass', payload);
          break;
        }
        case 'volunteer': {
          res.render('pages/attendee/volunteer/pass', payload);
          break;
        }
      }
    } catch (err) {
      if (err instanceof NotFoundError) {
        // requireWebAuth put an attendee session on the request, but
        // req.session is typed as the union — narrow rather than assume the
        // route's own middleware ran.
        const { session } = req;
        const attendeeId =
          session?.type === 'attendee' ? session.attendeeId : undefined;

        req.log.warn(
          { attendeeId, code: err.code },
          'Pass session references missing profile - clearing stale session',
        );

        await new AttendeeService({ req, res }).logoutAttendee();

        return res.redirect('/checkin?error=' + err.code);
      }

      next(err);
    }
  },
);

/**
 * The volunteer scanning surface.
 *
 * Two guards rather than one: `requireWebAuth` sends anyone without an attendee
 * session to check in, and the permission guard sends a signed-in attendee who
 * simply is not a redeemer back to their own pass. Neither renders an error —
 * a bookmarked link going quiet is not a fault worth a stack of red.
 *
 * `noStore` is here although this page renders no attendee data: the review card
 * is built in the browser from a `POST` response. It carries the rule anyway, so
 * that a screen given something to render server-side later inherits it without
 * anybody remembering to.
 */
router.get(
  '/staff',
  noStore,
  requireWebAuth('attendee', '/checkin'),
  attendeeSessionLimiter,
  requireRedeemPermissionWeb('/pass'),
  (req, res) => {
    res.render('pages/attendee/staff/scan', {
      title: res.locals.chrome.titleStaff({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      audience: toAudienceRole(req.query.audience) ?? 'volunteer',
      ticketPattern: TICKET_INPUT_PATTERN,
      bandEnabled: env.passBandEnabled,
      messages: inlineCatalogs(res.locals.locale, ['staff', 'qr', 'chrome']),
      copy: getCopy(res.locals.locale, ['staff', 'qr']),
    });
  },
);

/**
 * The raffle draw surface.
 *
 * The same two guards as `/staff`, reading the other flag. A volunteer who is
 * not running the draw lands back on their own pass rather than on an error:
 * there is nothing wrong with their session, there is simply nothing for them
 * here. `noStore` is here for the same reason it is on `/staff`.
 */
router.get(
  '/raffle',
  noStore,
  requireWebAuth('attendee', '/checkin'),
  attendeeSessionLimiter,
  requireDrawPermissionWeb('/pass'),
  (req, res) => {
    res.render('pages/attendee/raffle/draw', {
      title: res.locals.chrome.titleRaffle({ appTitle: env.appTitle }),
      nodeEnv: env.nodeEnv,
      audience: toAudienceRole(req.query.audience) ?? 'volunteer',
      messages: inlineCatalogs(res.locals.locale, ['raffle']),
      copy: getCopy(res.locals.locale, ['raffle']),
    });
  },
);

// After every route, so the `formBody` parser's failures reach the web error
// page as the client errors they are rather than as a 500.
router.use(normaliseBodyParserError);

// Last, so an error raised by any page above it reaches it. An attendee's,
// volunteer's or visitor's Redis outage becomes the 503 page; the admin pages
// are left to the error handler as they were.
router.use(redisOutageToUnavailable);

export default router;
