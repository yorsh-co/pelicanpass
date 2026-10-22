import type { LabelledAdminNavItem } from '../constants/admin-nav.ts';
import type { AdminScope } from '../constants/admin-scopes.ts';
import type { CopyDefaults } from '../constants/copy-defaults.ts';
import type { Credit } from '../constants/credit.ts';
import type { RedemptionItem } from '../constants/pass.ts';
import type { MessagesOf } from '../i18n/generated/registry.ts';
import type { LocaleLink } from '../i18n/server.ts';
import type { Locale } from '../i18n/locales.ts';
import type { Session, SessionType } from './session.ts';

/**
 * Session fields that `auth.middleware` attaches to the request.
 *
 * Augments `express-serve-static-core` rather than the `Express` global
 * namespace: both reach `Request`, but `@typescript-eslint/no-namespace`
 * rejects the `declare global { namespace Express }` form under this config.
 *
 * This file must stay a module — the import above is what makes it one. In a
 * script file, `declare module 'x'` declares an ambient module that *replaces*
 * the real one instead of merging into it.
 *
 * Every field is optional because it genuinely is: `resolveSessions` sets
 * `sessions`/`sessionIds`, and only `requireSessionType` and `requireWebAuth`
 * go on to set the singular `session`/`sessionId`. Routes that skip those
 * middlewares reach handlers with all four absent.
 */
declare module 'express-serve-static-core' {
  interface Request {
    /** Every session resolved from the request cookies, keyed by type. */
    sessions?: Partial<Record<SessionType, Session>>;

    /** Session IDs matching {@link Request.sessions}. */
    sessionIds?: Partial<Record<SessionType, string>>;

    /** The session the current route requires. */
    session?: Session;

    /**
     * Session ID matching {@link Request.session}.
     *
     * Explicitly `| undefined` because `requireSessionType` assigns it from a
     * `Partial` lookup that can miss — under `exactOptionalPropertyTypes` the
     * bare `?` would mean "absent", not "present and undefined".
     */
    sessionId?: string | undefined;

    /**
     * Which items the volunteer on this request may record, set by
     * `requireRedeemPermission` from the row it already reads.
     *
     * Explicitly `| undefined` for the same reason as {@link Request.sessionId}:
     * under `exactOptionalPropertyTypes` the bare `?` would mean "absent"
     * rather than "present and undefined".
     */
    redeemScopes?: RedemptionItem[] | undefined;

    /**
     * The exact bytes of the request body, kept by the WhatsApp webhook
     * router's own parser.
     *
     * **Set on that one route and nowhere else.** Meta signs the raw bytes, and
     * a parsed body cannot be re-serialised byte-identically, so the signature
     * has to be checked against what arrived. Every other route reads
     * `req.body` and must not start depending on this.
     */
    rawBody?: Buffer | undefined;
  }

  /**
   * Values the admin shell's views read off the response.
   *
   * `Locals` extends `Record<string, any>`, so these compile without being
   * declared. They are declared anyway because this is the contract between
   * `adminChrome` and `layouts/admin.ejs`, and a view cannot type-check itself
   * — a typo on this side is the only place the mismatch can still be caught.
   *
   * Optional because every page that is not the admin shell renders without
   * them; `cspNonce` is not listed because `app.ts` sets it on every response.
   */
  interface Locals {
    /**
     * Build this response was rendered by, from `env.releaseId`.
     *
     * Set on every response in `app.ts`, like `cspNonce`, and rendered onto
     * `<html data-release>` so the client error reporter can attribute a browser
     * stack trace to a bundle.
     */
    releaseId?: string;

    /**
     * The locale this response renders in.
     *
     * Defaulted in `app.ts` on every response and resolved by
     * `localeMiddleware` for the web routes; the layouts render it onto
     * `<html lang>`.
     */
    locale: Locale;

    /**
     * The shared chrome's messages in {@link locale}, for the header, footer and
     * other partials every page includes. Set alongside `locale`.
     */
    chrome: MessagesOf['chrome'];

    /**
     * The values filled into the copy placeholders, for the views that name
     * the event. Set on every response in `app.ts`.
     */
    copyDefaults: CopyDefaults;

    /**
     * The software's authorship credit, shown in the footer. Fixed, so unlike
     * {@link copyDefaults} no event setting overrides it. Set alongside it.
     */
    credit: Credit;

    /**
     * The language switcher in the public footer and the admin rail, set
     * alongside `locale`. Empty when fewer than two locales are offered.
     */
    localeLinks: readonly LocaleLink[];

    /**
     * The admin shell's messages, for the admin layout, the rail and wording
     * shared across admin screens, in {@link locale}. Set by `adminChrome`.
     */
    shell?: MessagesOf['admin-shell'];

    /** Name shown in the rail's footer, from the session. */
    adminUsername?: string;

    /** Sections this administrator may see, set by `adminChrome`. */
    adminNav?: readonly LabelledAdminNavItem[];

    /**
     * Every scope this administrator holds, set by `adminChrome` from the read
     * it already makes.
     *
     * For deciding what a page *draws* — a control the caller cannot use is
     * noise. Never for deciding what they may *do*: the route's own
     * `requireAdminScopeWeb` and the endpoint's `requireAdminScope` are the
     * gates, and they re-read rather than trusting this.
     */
    adminScopes?: readonly AdminScope[];

    /**
     * Set by `loadShed` on a request it turned away, so `httpCounters` and the
     * HTTP logger treat that 503 as a refusal rather than a server failure.
     */
    shed?: boolean;
  }
}
