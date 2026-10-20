import type { AdminScope } from './admin-scopes.ts';

/**
 * Every section of the administrator surface, in the order the rail lists them.
 *
 * One source of truth for the rail, the phone drawer and the arrival grid, so
 * that a section cannot appear in one and be missing from another.
 *
 * The arrival screen is deliberately **not** an entry. Every entry pairs with
 * the scope its route enforces, and `/admin` has no scope gate — an entry with
 * no gate would break the invariant that makes this file worth having. The way
 * back to `/admin` is the rail's title.
 *
 * The raffle is absent for a different reason: `raffle:read` and `raffle:write`
 * exist as scopes but nothing reads them yet, the way `admins:write` is
 * reserved by migration 013 without being actionable. An entry arrives with the
 * screen, not before it.
 */

/** Identifies a section; its label is `admin-shell.nav.<key>`. */
export type AdminNavKey =
  | 'attendees'
  | 'lookup'
  | 'whatsapp'
  | 'redemptions'
  | 'tshirts'
  | 'volunteers'
  | 'metrics'
  | 'survey'
  | 'pass'
  | 'exports'
  | 'import'
  | 'admins';

/** One section of the administrator surface. */
export interface AdminNavItem {
  /** Matches the `navKey` its route passes, which is what marks it current. */
  key: AdminNavKey;

  /** Where the section lives. */
  href: string;

  /**
   * Material Symbols ligature drawn beside the label.
   *
   * **Must be in the committed subset** — `docs/infrastructure/asset-delivery.md` lists it. A
   * glyph outside it renders as its literal ligature text, silently and with no
   * console error.
   */
  icon: string;

  /**
   * The scope that reveals it — **the same one its route enforces**.
   *
   * Pairing the two is the point of this file: the nav and the gate read one
   * value, so an operator cannot be shown a section that will then redirect
   * them, and a section cannot be gated more tightly than it is advertised.
   */
  scope: AdminScope;

  /**
   * Whether the screen exists.
   *
   * Not speculative configurability: the arrival screen's job is to tell an
   * operator what this deployment can do, and on event day "Importar — em
   * breve" is a more useful answer than a section that silently is not there.
   * A `planned` entry renders non-interactive, and flips to `ready` in the same
   * commit as its screen.
   */
  status: 'ready' | 'planned';
}

/** A section as the rail and the arrival screen draw it. */
export interface LabelledAdminNavItem extends AdminNavItem {
  /** What the operator reads, from `admin-shell.nav.<key>`. */
  label: string;
}

/**
 * The sections, ordered by how often someone reaches for them on event day.
 *
 * Ships complete and entirely `planned` — the shell is the frame, and no screen
 * has been built into it yet.
 */
export const ADMIN_NAV: readonly AdminNavItem[] = [
  {
    key: 'metrics',
    icon: 'monitoring',
    href: '/admin/metrics',
    scope: 'metrics:read',
    status: 'ready',
  },
  {
    // Gated on the write scope alone, like `pass`: the screen is an editor, and
    // it lists who holds which access, which a read-only operator has no use
    // for.
    key: 'volunteers',
    icon: 'how_to_reg',
    href: '/admin/volunteers',
    scope: 'volunteers:write',
    status: 'ready',
  },
  {
    key: 'attendees',
    icon: 'group',
    href: '/admin/attendees',
    scope: 'attendees:read',
    status: 'ready',
  },
  {
    key: 'redemptions',
    icon: 'redeem',
    href: '/admin/redemptions',
    scope: 'redemptions:read',
    status: 'ready',
  },
  {
    // Reading is what opens the screen; `checkin:write` gates the mark-present
    // action inside it. A volunteer holding only `attendees:read` gets a lookup
    // that reads and cannot mark.
    key: 'lookup',
    icon: 'person_search',
    href: '/admin/lookup',
    scope: 'attendees:read',
    status: 'ready',
  },
  {
    // Gated on `tshirt:redeem` alone: the desk is where a purchased T-shirt is
    // handed over, so an operator holding only that scope sees this section and
    // nothing else on the rail.
    key: 'tshirts',
    icon: 'checkroom',
    href: '/admin/tshirts',
    scope: 'tshirt:redeem',
    status: 'ready',
  },
  {
    // Behind `export:read`, the lower of its two scopes: whoever may take the
    // answers away may see the state and counts. The override on the page
    // additionally needs `survey:write`, which its API enforces.
    key: 'survey',
    icon: 'edit',
    href: '/admin/survey',
    scope: 'export:read',
    status: 'ready',
  },
  {
    // Gated on the write scope alone: the screen is an editor, and a read-only
    // copy would put an entry in front of every lookup volunteer for nothing.
    key: 'pass',
    icon: 'id_card',
    href: '/admin/pass',
    scope: 'pass:write',
    status: 'ready',
  },
  {
    // A pre-event tool, so it sits with the setup screens below the event-day
    // ones: it is used in the week before, not on the night.
    key: 'whatsapp',
    icon: 'send',
    href: '/admin/whatsapp',
    scope: 'whatsapp:send',
    status: 'ready',
  },
  {
    key: 'exports',
    icon: 'download',
    href: '/admin/exports',
    scope: 'export:read',
    status: 'planned',
  },
  {
    key: 'import',
    icon: 'upload_file',
    href: '/admin/import',
    scope: 'attendees:import',
    status: 'planned',
  },
  {
    key: 'admins',
    icon: 'admin_panel_settings',
    href: '/admin/admins',
    scope: 'admins:write',
    status: 'planned',
  },
];
