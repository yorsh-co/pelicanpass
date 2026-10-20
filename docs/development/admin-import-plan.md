# Admin CSV Import — Implementation Plan

**Status:** proposed. Nothing below is built yet; [`imports.md`](../operations/imports.md)
describes the CLI imports as they are today.

Brings the two CSV imports to `/admin/import`, behind the reserved
`attendees:import` scope. The CLI scripts stay, unchanged in behaviour, for
loads from a shell.

## Starting point

- **The rules are already pure and shared-ready.**
  `src/modules/admin/admin.attendees.import.ts` and
  `admin.volunteer-permissions.import.ts` parse and plan without touching the
  database, and are unit-tested. `scripts/db/import-attendees.ts` and
  `scripts/db/set-volunteer-permissions.ts` only read stdin, run the SQL as
  `pelicanpass_migrator`, and print. The web reuses `parse*` and `plan*`, so the
  two paths cannot drift on what a file means.
- **The scope and nav entry exist.** `attendees:import` is in the `CHECK`
  constraint since migration 014, and `src/constants/admin-nav.ts` carries a
  `planned` entry for `/admin/import`. No scope migration is needed.
- **The application role is narrower than the migrator.**
  - `INSERT`/`UPDATE` on the registration fields (name, phone, role, the five
    option columns), from migrations 016, 026 and 028.
  - No write on `team`, `team_role` or `checkin_time` (024, 035): the only
    application write path is `set_volunteer_permissions`, which requires
    `volunteers:write`, refuses archived rows and audits every change.
  - The same function is the only write path for `can_redeem`,
    `redeem_scopes`, `can_draw` and `show_admin_link` (032).
  - No write path at all for `admin_username` (031).
- **The API's JSON parser caps bodies at 10 KB** (`src/api/index.ts`). A
  700-row roster is around 70 KB.

## Design

### Two write paths, one set of rules

|                                                | CLI (unchanged)          | Web                                                                                                |
| ---------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------- |
| Role                                           | migrator                 | application                                                                                        |
| Roster registration fields                     | direct SQL               | direct SQL, under the editor's grants                                                              |
| `team`, `team_role`, `checkin_time`            | direct SQL               | `set_volunteer_permissions`; the file is refused unless the administrator also holds `volunteers:write` |
| Permission columns                             | direct SQL, unaudited    | `set_volunteer_permissions` per row, audited in `volunteer_permission_changes`; needs `attendees:import` and `volunteers:write` |
| `admin_username`                               | written                  | the file is refused; setting it stays CLI-only                                                     |
| Archived volunteer with a team or permission change | written and reported | refused as a problem, since the function will not write it                                         |

The scripts keep connecting as the migrator, with the same flags and the same
output.

### Transport

- The browser reads the file with `FileReader` and posts
  `{ csv, previewToken? }` as JSON. No multipart dependency, and
  `requireSupportedContentType` is untouched.
- A parser-only mount, `router.use('/admin/import', express.json({ limit: '512kb' }))`,
  sits directly above the global `express.json`, as `/client-errors` does. It
  only parses: the request then falls through to the `/admin` mount and its
  session check, `adminSessionLimiter` and scope gate as usual.
- A 5,000-row cap in the parser, mirrored by a size check in the browser.

### Preview, then commit

Modelled on the WhatsApp sender's preview token.

- `POST /api/v1/admin/import/{roster|permissions}/preview`
  - Reads the existing rows and plans, writing nothing.
  - Returns the structured report and a `previewToken`.
  - Stores `{ adminId, kind, sha256(csv), planDigest }` in Redis under a
    hashed key, for 10 minutes. **No name or phone ever reaches Redis.**
- `POST /api/v1/admin/import/{roster|permissions}/commit`
  - The browser re-sends the same CSV with the token.
  - `getdel` makes the token single-use; the administrator, kind and CSV digest
    must match.
  - In one transaction: `SELECT … FOR UPDATE`, re-plan, compare the plan
    digest. A mismatch is `409 importChanged` — the roster moved since the
    preview, and the operator previews again.
  - Writes, commits, and returns the report.
  - Behind `idempotent('import-commit')`, so a re-tap after a timeout replays
    the first answer.
- One `app_events` row per committed import: kind, counts and the
  administrator's actor digest, nothing else.

### Structured issues

Problems and warnings are English strings today, and
`src/types/admin-refusal.ts` keeps English diagnostics off admin pages.

- Both import modules return typed issues,
  `{ line, ticketCode, key, column?, params? }`, instead of strings.
- `formatIssue()` renders them in English for the CLI. Golden tests of the
  current output land **before** the refactor, so the CLI report stays
  byte-identical.
- Rules that throw a bare `Error` today (team label length, `checkin_time`)
  gain refusal keys.
- The web renders issues from a new `admin-import` message namespace.

### Screen

- `/admin/import`, behind `adminPage('attendees:import')`, with _Roster_ and
  _Permissions_ tabs. The permissions tab is shown only to an administrator who
  also holds `volunteers:write`.
- Choose a file → _Preview_ → report → _Import_ through `slide-confirm` →
  result. `unload-guard` holds while a preview is pending.
- The report carries the CLI's sections, with ticket codes and line numbers
  only.
- The nav entry moves from `planned` to `ready`.

## Phases

Each phase is its own git-flow branch off `develop`.

1. **`refactor/import-structured-issues`**
   - Golden tests for the current English output of both scripts.
   - `ImportIssue` and `formatIssue`; both modules and both scripts move to
     them. No behaviour change.
2. **`feature/admin-import-api`**
   - Parser mount, routes, controller and service for preview and commit.
   - Roster writes: insert and update as the application role, then
     `set_volunteer_permissions` for team columns on new and existing
     volunteers, in the same transaction.
   - Permission writes through the function.
   - Redis preview store, plan digest, new refusal keys, `app_events`.
   - Service tests with a faked repository and Redis, in the style of
     `admin.tshirts.service.test.ts`, covering: plan digest mismatch, expired
     or reused token, another administrator's token, missing
     `volunteers:write`, `admin_username` refused, archived volunteer refused,
     row and size caps.
3. **`feature/admin-import-ui`**
   - View, client page, stylesheet, `admin-import` catalog (pt-BR, generated
     `en-XA`), nav set to `ready`.
   - A manual acceptance checklist.
4. **`docs/admin-import`** — the documentation below and the CHANGELOG entry.

## Documentation

- **`imports.md`** — a _From the admin screen_ section at the top: scopes,
  preview and import, the CLI/web table above, the size cap. The CLI sections
  stay.
- **`admin-scopes.md`** — `attendees:import` leaves _Reserved_; what it permits
  with and without `volunteers:write`; a _Roster loader_ recipe.
- **`README.md`** — an Admin bullet for the screen; the Roadmap line split so
  import is checked and exports stay open; the `imports.md` row in the
  documentation table; a line in _The API middleware chain_ on the
  route-specific parser.
- **`reviewer-guide.pt-BR.md`**
  - §5: an _Importação pelo admin_ subsection — scopes, the parser above
    `express.json`, no personal data in Redis, the function-only write path,
    and why the CLI keeps the migrator.
  - §6: the parser mount order and the archived-volunteer refusal are
    deliberate.
  - §7: a review checklist item.
  - §9: _dry run → simulação_, _preview → pré-visualização_.
  - §10: the index row.
- **Checked, and updated where they apply:** `security-overview.md` (L8:
  `attendees:import` then guards a route), `rate-limiting.md` (the route
  matrix), `data-retention.md` (the Redis preview key), `copy-inventory.md`
  (regenerated by the i18n scripts).

## To verify in phase 2

- The request deadline and statement timeout allow a single-transaction import
  of 5,000 rows; raise them for these routes only if measurement says so.
- `app_events` accepts a new kind without a migration.
- `SELECT … FOR UPDATE` works for the application role on `attendees`.
  Postgres requires `UPDATE` on at least one column, which the role holds.
