# Admin scopes

What each administrator scope opens, what it enables inside other screens, and
which scopes to grant for each job on the day. How to grant them — the scripts,
replace-not-merge, disabling an account — is in
[`deployment.md` § Operations](../operations/deployment.md#operations) and is not repeated
here.

**The code is authoritative.** The scope list is
[`src/constants/admin-scopes.ts`](../../src/constants/admin-scopes.ts). The gates
are `adminPage(...)` in
[`src/web/routes/web.routes.ts`](../../src/web/routes/web.routes.ts) for rendered
pages, and `requireAdminScope(...)` in
[`src/modules/admin/admin.routes.ts`](../../src/modules/admin/admin.routes.ts),
[`src/api/index.ts`](../../src/api/index.ts) and
[`src/modules/metrics/metrics.routes.ts`](../../src/modules/metrics/metrics.routes.ts)
for the API. If this document disagrees with them, this document is wrong. What
it adds is the view the code cannot give in one place: every gate for a scope
side by side, and the combinations a person actually needs.

---

## How gating works

- **Scopes are `resource:action`, not roles.** A role would be a second name for
  a set the gates already check. The [recipes](#recipes) below are the roles,
  written down rather than stored.
- **Two layers, checked independently.** A rendered page's scope decides whether
  the screen opens; refused, it redirects to `/admin`. An API mount's scope
  decides whether a write is allowed; refused, it answers `403`. A screen often
  opens on a lower scope than its controls need and simply does not draw them —
  the API still refuses on its own if one is sent anyway.
- **The nav matches the page gate.** Each entry in
  [`src/constants/admin-nav.ts`](../../src/constants/admin-nav.ts) carries the same
  scope as its route, so an operator is never shown a section that redirects.
- **Every gate re-reads Postgres.** A change to someone's scopes, or disabling
  them, applies on their next request.
- `/admin` itself, `/api/v1/admin/me` and sign-out need no scope. An account
  with none sees an empty arrival screen.

---

## Scope reference

| Scope             | Opens                                                                             | Enables inside other screens                                                   | API                                                         |
| ----------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `attendees:read`  | `/admin/attendees` (roster, blank form, record), `/admin/lookup` (search, record) | The ticket limit status on the roster                                          | —                                                           |
| `attendees:write` | —                                                                                 | Save, archive and restore on the roster and record; the door WhatsApp checkbox | `/api/v1/admin/attendees/*`                                 |
| `checkin:write`   | —                                                                                 | _Mark present_ on the lookup and the attendee editor                           | `/api/v1/admin/lookup/*`                                    |
| `whatsapp:send`   | `/admin/whatsapp`                                                                 | The door message switch on the roster                                          | `/api/v1/admin/whatsapp/*`, `/api/v1/admin/whatsapp-door/*` |
| `metrics:read`    | `/admin/metrics`                                                                  | The ticket limit status on the door panel                                      | `/api/v1/admin/metrics/snapshot`                            |
| `export:read`     | `/admin/survey`, `/admin/survey/export.csv`                                       | The Feedback card on `/admin/metrics`                                          | —                                                           |
| `survey:write`    | —                                                                                 | The override control on `/admin/survey`                                        | `/api/v1/admin/survey/*`                                    |
| `pass:write` | `/admin/pass` | — | `/api/v1/admin/pass/*` |
| `redemptions:read` | `/admin/redemptions` (totals, list, record) | — | `GET /api/v1/admin/redemptions/summary` |
| `redemptions:write` | — | _Undo_ and _Mark collected_ on the redemption record | `POST /api/v1/admin/redemptions/*` |
| `volunteers:write` | `/admin/volunteers` (list, record) | — | `POST /api/v1/admin/volunteers/*` |
| `tshirt:redeem` | `/admin/tshirts` (search, record) | — | `POST /api/v1/admin/tshirts/*` |
| `attendees:limit` | — | _Edit_ and the limit form on the roster panel | `POST /api/v1/admin/ticket-limit` |

Four more exist and gate nothing yet: see [Reserved](#reserved).

### `attendees:read`

The base scope for anyone working with attendees. It opens the roster, the
blank form, each record, and the door lookup — including the lookup's record
page, the one screen that shows an attendee's verification code. On its own,
every one of those is read-only: no save, no archive, no mark-present, no
WhatsApp checkbox.

It also shows the ticket limit's status on the roster: the pill, mode, meter and
remaining count, read-only. While the limit is off, a viewer with only this
scope sees no panel. Setting the limit needs [`attendees:limit`](#attendeeslimit).

### `attendees:write`

Every write on the roster editor: create, edit, archive, restore, clear a
nickname. It adds nothing on its own — the screens it writes from open on
`attendees:read`.

**It is also what sends the door message.** The WhatsApp message sent from the
form, to a walk-in or to an attendee whose number was corrected, rides on the
create or edit request, so `attendees:write` is the only scope the operator
needs. `whatsapp:send` does not. Whether the message actually goes is decided by
the switch, `.env` and the budget — see
[`whatsapp-integration.md` § Door message](./whatsapp-integration.md#door-message).

### `checkin:write`

Marking an attendee present from the lookup, standing in for the QR scan and
the verification code. Deliberately separate from `attendees:read`: someone
holding only that gets a lookup that reads and cannot mark. It is also separate
from `attendees:write` — a door volunteer who marks people present has no
reason to edit them.

The attendee editor offers the same action through the same endpoint, so an
editor operator needs `checkin:write` alongside `attendees:write` to see it.
`attendees:write` does not imply it.

### `whatsapp:send`

The decision to spend money on messages. Two things:

- `/admin/whatsapp`, the bulk sender, with its preview, runs and test send.
- The door message **switch**, a panel on `/admin/attendees`. Because the panel
  sits on the roster, this scope needs `attendees:read` alongside it to be
  reachable.

It does not send door messages itself; that is `attendees:write`, once the
switch is on.

### `metrics:read`

The live dashboard and the snapshot it polls. The door panel also shows the
ticket limit status, as the roster does, with no `attendees:read` or
`attendees:limit` needed; it is read-only and hidden while the limit is off.
The questionnaire card needs [`export:read`](#exportread) as well.

### `export:read`

`/admin/survey` and each audience's CSV download. The questionnaire page is
gated on the lower of its two scopes: whoever may take the answers away may see
the state and counts.

With `metrics:read` it also draws the _Feedback_ card on `/admin/metrics`: the
same totals, refreshed with the panel. Without `export:read` the snapshot does
not read them and the card is not rendered.

### `survey:write`

The questionnaire override — _Automático_, _Forçar aberto_, _Forçar fechado_.
The control is drawn only for this scope, but it lives on a page that opens on
`export:read`, so running the questionnaire needs both. See
[`survey.md` § The administrator surface](./survey.md#the-administrator-surface).

### `pass:write`

The welcome schedule: when the line under every attendee's name switches text.
Opens `/admin/pass`, which shows the schedule in force and edits it; a saved
schedule replaces `PASS_WELCOME_SCHEDULE` until it is handed back to `.env`
there. The page has no read-only form — it is an editor, and a copy for
`attendees:read` would put an entry in front of every lookup volunteer. Added
by migration `029`.

### `volunteers:write`

Volunteers' permissions: which stations they may record collections at, the
raffle, the admin link on their pass, and their team and role. Opens
`/admin/volunteers`, a list with filters by access, team and name, and a
record per volunteer with the change history. Like `pass:write`, the page has
no read-only form. The linked `admin_username` is shown but not editable: it
changes through the volunteer permissions import. Every save is written to
`volunteer_permission_changes` by the `set_volunteer_permissions` database
function. Added by migration `032`.

### `tshirt:redeem`

The T-shirt desk: search for an attendee who bought a shirt and record that it
was handed over. Opens `/admin/tshirts`, a search by name, nickname, ticket code
or phone digits, and a record per attendee with the size to hand over. It also
permits the one write behind it, so the desk needs no other scope: not
`attendees:read`, and not `redemptions:read` or `redemptions:write`. It is meant
for the T-shirt desk team and for no one else.

**The record page shows the attendee's verification code** — the last four digits
of their phone — one record at a time, so the desk can confirm who is standing
at the counter. Search results never show it. Grant it as deliberately as
`attendees:read`, whose lookup record is the other place the code appears.

A handover is recorded under the administrator's account as an ordinary
`redeemed` outcome, so it counts in the redemptions totals like a counter tap.
There is no undo here; corrections stay on `/admin/redemptions`. Added by
migrations `033` and `034`.

The volunteer's pass shows `CAMISETAS` for this scope only once their attendee
row is linked to the account through `admin_username`; see
[Pass access tiers](#pass-access-tiers).

### `attendees:limit`

The ticket limit: how many participant tickets the attendees editor may issue,
what counts towards it, and whether reaching it refuses the ticket or only
warns. Lets the holder set and edit it: it adds the Edit button and form to the
limit panel on `/admin/attendees` and permits `POST /api/v1/admin/ticket-limit`.
Seeing the status needs only `attendees:read`; because the panel sits on the
roster, this scope needs `attendees:read` alongside it to be reachable. An
editor sees the panel even while the limit is off, to switch it on.

**Deliberately separate from `attendees:write`.** The people who create tickets
at the door are the ones the limit constrains; if saving a ticket also let them
change the cap, it would stop them in name only. Reading the limit, which the
editor's form does to show how many tickets remain, needs only
`attendees:write`. Added by migration `037`.

### `redemptions:read`

The redemptions screen: per-item totals and the per-option breakdown, the list
of who is entitled to an item, and each attendee's record with the counter's
full history. Read-only on its own. The totals poll has its own limiter, so an
open screen never spends the budget the corrections draw on.

### `redemptions:write`

_Undo_ a collection or _Mark collected_ by hand, one item at a time, each with a
reason code. Every correction is written to `redemptions` as a row of its own,
under the administrator's account. It adds nothing on its own — the record opens
on `redemptions:read`. Changing an attendee's size or choice is not this scope;
that is `attendees:write`, on the roster record.

### Reserved

Grantable — the `CHECK` constraint and the scripts accept them — but no route
reads them yet. Granting one today changes nothing.

| Scope               | Intended for                    | Nav             |
| ------------------- | ------------------------------- | --------------- |
| `attendees:import`  | Importing the roster from CSV   | `planned` entry |
| `raffle:read`       | The raffle, read side           | —               |
| `raffle:write`      | The raffle, draw side           | —               |
| `admins:write`      | Managing administrator accounts | `planned` entry |

Until those screens exist, the roster import and administrator management are
done from a shell — [`imports.md`](../operations/imports.md) and
[`deployment.md` § Operations](../operations/deployment.md#operations).

---

## Recipes

Ready to paste into `--scopes`:

| Job                                 | Scopes                           |
| ----------------------------------- | -------------------------------- |
| Door lookup, read-only              | `attendees:read`                 |
| Door lookup, marking people present | `attendees:read,checkin:write`   |
| Walk-in desk / roster editor        | `attendees:read,attendees:write` |
| Walk-in desk that also marks present | `attendees:read,attendees:write,checkin:write` |
| WhatsApp supervisor                 | `attendees:read,whatsapp:send`   |
| Live dashboard                      | `metrics:read`                   |
| Questionnaire organiser             | `export:read,survey:write`       |
| Pass welcome scheduler              | `pass:write`                     |
| Redemptions desk                    | `redemptions:read,redemptions:write` |
| Redemptions, watching only          | `redemptions:read`               |
| Volunteer coordinator               | `volunteers:write`               |
| T-shirt desk                        | `tshirt:redeem`                  |
| Ticket limit owner                  | `attendees:read,attendees:limit` |

The walk-in desk sends door messages with no WhatsApp scope; the supervisor
decides whether they go at all. Combine recipes by joining them — the scripts
drop duplicates.

A door lookup account also needs a way to reach `/admin` from the volunteer's
phone; provisioning only the scopes leaves them holding credentials they cannot
use. See _Volunteer lookup accounts_ in
[`deployment.md` § Operations](../operations/deployment.md#operations).

The volunteer's pass shows `CONSULTA` for these scopes only once their attendee
row is linked to the account through `admin_username`; see
[Pass access tiers](#pass-access-tiers).

---

## Not admin scopes

Volunteer station permissions — `can_redeem`, `redeem_scopes` and `can_draw` —
are columns on the volunteer's own attendee row, not administrator scopes. They
govern the volunteer surfaces reached from a check-in session, not `/admin`.
They are set on `/admin/volunteers` under
[`volunteers:write`](#volunteerswrite) for one volunteer, with the
[volunteer permissions import](../operations/imports.md#volunteer-permissions-import) for
many, or as the migrator role in [`db-cheatsheet.md`](../operations/db-cheatsheet.md). A volunteer who both hands out t-shirts and works the door lookup needs
both: the station columns on their attendee row, and an administrator account
with the lookup's scopes. The row may also name that account in
`admin_username`, which lets their pass show what they can do
([below](#pass-access-tiers)). The link grants nothing: the account's own scopes
are what every `/admin` gate checks.

---

## Pass access tiers

A volunteer's pass shows what they can do: a tab beside the logo, in the
tier's colour, carrying a role chip with its own text and fill, so a team leader
can tell at a glance what to expect of someone. A volunteer with actions but no
tier gets a neutral `VOLUNTÁRIO` tab. A volunteer with no actions keeps the
plain `VOLUNTÁRIO` chip in the header and has no tab. Participants have no tier
and their pass is unchanged. The rules are in
[`attendee.access-tier.ts`](../../src/modules/attendee/attendee.access-tier.ts).

| Tier            | Rule                                                                    | Badge                  | Tab colour       |
| --------------- | ----------------------------------------------------------------------- | ---------------------- | ---------------- |
| `edit`          | Linked active admin holds `attendees:read` and `attendees:write`        | `CADASTRO`             | Navy `#1e2a78`              |
| `lookup`        | Linked active admin holds `attendees:read` and `checkin:write`          | `CONSULTA`             | Deep red `#b91c1c` |
| `tshirt`        | Linked active admin holds `tshirt:redeem`                               | `CAMISETAS`            | Deep gold `#7a5600` |
| `redeem`        | `can_redeem` with at least one valid station, as the `/staff` gate reads it | `RETIRADAS`        | Dark teal `#0f766e` |
| `raffle`        | `can_draw`                                                              | `GERADOR DE N°`        | Deep magenta `#7a1456` |
| `none`          | Any other volunteer                                                     | `VOLUNTÁRIO`           | Neutral, or no tab |

**The highest row that applies wins.** A volunteer who hands out t-shirts and
also runs the raffle shows `RETIRADAS`, not `GERADOR DE N°`, and one who can
both look up and redeem shows `CONSULTA`.

- **Lookup means marking people present.** `attendees:read` alone, a read-only
  lookup, counts as no tier: the volunteer cannot mark anyone present, so the
  pass does not offer `CONSULTA`.
- **The admin side needs the link.** `edit`, `lookup` and `tshirt` come from
  the account named in the attendee's `admin_username`, and only while that
  account is active. An unknown or disabled name, or none, contributes nothing.
  To link a volunteer, set the column through the
  [volunteer permissions import](../operations/imports.md#volunteer-permissions-import) or
  the single-row `UPDATE` in
  [`db-cheatsheet.md`](../operations/db-cheatsheet.md#inspect-and-reset).
- **Tap the tab for the actions.** Any volunteer with `can_redeem`, `can_draw`
  or the `/admin` link gets the tab. It opens a view holding exactly those links
  (`/staff`, `/raffle`, `/admin`): the tabs swap and the card takes the tier's
  colour. The wordmark tab, or _Voltar_, returns to the front. The `/admin` link
  shows when `show_admin_link` is set or when `admin_username` names an active
  administrator; like the tier, it is a label and grants nothing.
- **Changes show on the next poll, links on the next load.** The tier is sent
  again on every pass poll, about every 30 seconds, so a change to the station
  flags, the account's scopes, `is_active` or `admin_username` updates the tab's
  colour and chip on an open pass without a reload. The action links follow the
  profile and update on the next page load; a stale link is refused by its own
  gate.
- **It is a label, not a permission.** Every gate re-reads Postgres on its own
  request. A stale or wrong badge or link cannot open a screen, and a correct
  one cannot be used to get into one.
- **Every tier on one screen.** `/admin/volunteers` opens with a collapsed
  legend of every tier, highest first, with what it lets a volunteer do and
  what grants it, then lists each volunteer with the same chip, filterable by
  tier and team, for an administrator holding
  [`volunteers:write`](#volunteerswrite).
- **Ask what the badge says.** The tab colours share names with the colour
  band that rotates on the back of the pass, so a leader should read the badge
  aloud and treat the colour as a quick cue only.

### Legend for team leaders

The chip on the tab beside the logo names the volunteer's highest access; they
may hold the jobs below it too.

| Chip                   | What the volunteer can do                                          |
| ---------------------- | ------------------------------------------------------------------ |
| `CADASTRO`             | Register and edit attendees on the roster                          |
| `CONSULTA`             | Look up attendees and mark them present                            |
| `CAMISETAS`            | Hand out T-shirts at the T-shirt desk                              |
| `RETIRADAS`            | Hand out items at their station                                    |
| `GERADOR DE N°`        | Run the raffle draw                                                |
| `VOLUNTÁRIO`           | None of the above; at most a read-only lookup, or the `/admin` link |
