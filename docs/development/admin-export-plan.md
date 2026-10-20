# Admin Result Exports — Implementation Plan

**Status:** proposed. Nothing below is built yet;
[`data-retention.md`](../security/data-retention.md) and
[`deployment.md` § Teardown](../operations/deployment.md#teardown) describe the exports as
they are today.

Brings the result exports to `/admin/exports`, behind `export:read`. The CLI
exports stay, and `export-results.sql` gains an anonymous variant so both paths
offer the same files.

## Starting point

- **`scripts/db/export-results.sql`** runs as the read-only role through
  `COPY … TO STDOUT`. It omits name, phone and nickname (the nickname is also the
  one attendee-controlled string, and a formula risk in a spreadsheet). It keeps
  `ticket_code`, so the file is **pseudonymous**: per
  [`data-retention.md`](../security/data-retention.md#the-export-is-pseudonymous-not-anonymous),
  dropping that one column makes it anonymous. `ticket_code` and the option
  columns also go through a `regexp_replace` that applies the formula guard in
  SQL.
- **The survey export is already shared.** `scripts/survey/export-csv.ts` and
  `GET /admin/survey/export.csv` run the same query through the same
  `buildSurveyCsv`, which carries the formula guard, a byte-order mark and CRLF.
  One builder, two entry points: the model for this plan.
- **Redemption totals exist.** `buildRedemptionSummary()` counts per item and per
  option — expected, collected, pending present, pending absent — without
  archived attendees.
- **The scope and nav entry exist.** `export:read` opens `/admin/survey` today,
  and `src/constants/admin-nav.ts` carries a `planned` entry for
  `/admin/exports`. No migration is needed.
- **Retention constraints.** The results and survey files are the only
  artifacts meant to outlive the host, with the traffic summary. No attendee
  value travels in an admin URL. `/admin` stays open after `EVENT_CLOSES_AT`
  for the teardown's exports.

## What the results file answers

The results export keeps, per attendee, `ticket_code` beside each item's
entitlement and collection time:

| Item                | Entitled to             | Collected at                   |
| ------------------- | ----------------------- | ------------------------------ |
| Participant t-shirt | `tshirt_size`           | `tshirt_redeemed_at`           |
| Volunteer t-shirt   | `tshirt_volunteer_size` | `tshirt_volunteer_redeemed_at` |
| Meal                | `meal_option`           | `meal_redeemed_at`             |
| Drink               | `drink_option`          | `drink_redeemed_at`            |
| Lunch               | `lunch_option`          | `lunch_redeemed_at`            |

An uncollected t-shirt is a row with `tshirt_size` set and `tshirt_redeemed_at`
blank; the organisers match its `ticket_code` against their own ticket data.
The staff counter, the T-shirt desk and admin corrections all write these
columns, and an _undo_ blanks them, so the file holds the final state. Archived
registrations stay in the file with `archived_at` set and should be filtered
out before reconciling. `purge-attendees.sql` leaves `ticket_code` and these
columns alone, so the file is as useful after teardown step 0.

Only the **pseudonymous** variant answers this. The anonymous one has no code
to match.

The **redemption history** — every attempt, refusals, who served, and each
correction with its reason — is the `redemptions` table. It is not exported and
dies with the `data` volume. It stays out of scope here: it identifies the
serving volunteers as well as attendees, and is a retention decision of its own.

## Exports

| Export                    | Contents                                                                  | Identifies?                                   | Scope                            | Web                                     | CLI                      |
| ------------------------- | ------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------- | --------------------------------------- | ------------------------ |
| Results, anonymous        | `export-results.sql`'s columns without `ticket_code`                      | no                                            | `export:read`                    | new                                     | new `-v anonymous=1`     |
| Results, pseudonymous     | `export-results.sql`'s columns                                            | through the organiser's roster                | `export:read` + `attendees:read` | new                                     | unchanged                |
| Survey, per audience      | `buildSurveyCsv`                                                          | no; small groups can be identified by reading | `export:read`                    | existing route, linked from the screen  | unchanged                |
| Redemption totals         | item, option, expected, collected, pending present, pending absent        | no; aggregates                                | `export:read`                    | new                                     | none: derivable from the results file |
| Traffic summary           | request shape, no addresses                                               | no                                            | —                                | **no**: it reads `docker compose logs`  | unchanged                |
| `app_events`, log archive | errors and limiter trips                                                  | **yes**: addresses, actor ids                 | —                                | **never**                               | unchanged                |
| Names and phones          | —                                                                         | **yes**                                       | —                                | **never**                               | none, by policy          |

The screen lists the CLI-only rows too, one line each on why, linking the
teardown procedure.

## Design

### Shared CSV building

- **`src/shared/utils/csv.ts`** — the formula guard and RFC 4180 quoting, moved
  out of `survey.csv.ts` (the guard's `FORMULA_START` is in
  `src/constants/csv.ts`) unchanged, and a `buildCsv(header, rows)` that adds
  the byte-order mark and CRLF. `buildSurveyCsv` uses it; its tests pass
  unchanged.
- **`src/modules/exports/results.ts`**
  - `RESULTS_COLUMNS`: the same list, in the same order, as the `SELECT` in
    `export-results.sql`. **A test parses the SQL file and compares**, so adding
    a column means changing both, and stays a retention decision.
  - Values are cast `::text` in the query, so booleans and timestamps keep
    Postgres' `COPY` spelling. Order is `checkin_number NULLS LAST,
    ticket_code`, as in the SQL.
  - The anonymous variant drops `ticket_code` from the projection and the
    header.
- **Totals** — `buildRedemptionSummary()` serialised to CSV; no new query.
- The application role already holds `SELECT` on every column read (migrations
  005, 015, 026, 028).

### Routes

Page routes, like `/admin/survey/export.csv`: plain links followed with the
session cookie, no script needed.

- `GET /admin/exports` — `adminPage('export:read')`. One card per export,
  saying what it contains and whether it identifies anyone. The pseudonymous
  card is shown only with `attendees:read`.
- `GET /admin/exports/results.csv?variant=anonymous|pseudonymous` —
  `adminPage('export:read')`, and `pseudonymous` checks `attendees:read` on the
  route as well as hiding the card.
- `GET /admin/exports/redemptions.csv` — `adminPage('export:read')`.
- The survey cards link the existing `/admin/survey/export.csv?audience=…`,
  which stays where it is.
- The query picks a file, never a person. File names carry the event id and the
  date only, such as `results-anonymous-<event>-<yyyy-mm-dd>.csv`.
- `noStore` through `adminPage`, `Content-Disposition: attachment`, and
  `X-Content-Type-Options: nosniff` from helmet.

### Accountability

Each download writes one `app_events` row: the administrator, the export and
variant, and the row count. Nothing about any attendee. The survey route gains
the same row, so every download is recorded alike.

### CLI parity

`export-results.sql` gains a `\if :{?anonymous}` branch that projects the
columns without `ticket_code`. Without the variable, the output is
byte-identical to today's, checked by diffing against a capture taken before
the change.

## Retention, on the screen

- **Pseudonymous card** — personal data under LGPD while the organiser's roster
  exists; a deletion request after teardown means removing that person's line
  from this file.
- **Anonymous card** — the one to share.
- **Volunteer survey file** — the existing "easy to re-identify by reading"
  note.
- The results and survey files do not depend on `purge-attendees.sql`, but the
  screen reminds the operator that the questionnaire's completion record is
  purged before the final report, and links the teardown.
- A download lands on a device this deployment does not own. That is why names
  and phones are never offered, and why the pseudonymous file needs
  `attendees:read`: whoever holds it already sees ticket codes on screen.

## Phases

Each phase is its own git-flow branch off `develop`.

1. **`refactor/shared-csv`**
   - Extract `csv.ts`; `buildSurveyCsv` uses it with its tests unchanged.
   - Unit tests for quoting, the formula guard, the byte-order mark and CRLF.
2. **`feature/admin-exports`**
   - Results module, both variants, and the test against `export-results.sql`.
   - Totals CSV.
   - Routes, the second scope check, `app_events` rows (survey route
     included), the `\if` branch with its byte-identity check, view,
     `admin-exports` catalog, stylesheet, nav set to `ready`.
   - Tests:
     - the anonymous header carries no `ticket_code`, and no header carries
       `name`, `phone` or `nickname`;
     - `pseudonymous` without `attendees:read` is refused;
     - an unknown `variant` is refused;
     - the formula guard on option values;
     - the totals CSV agrees with `buildRedemptionSummary`.
3. **`docs/admin-exports`**
   - **`data-retention.md`** — the web downloads as a second way to produce the
     kept artifacts; the totals file in the artifact table as keepable
     indefinitely; teardown step 1 offers the screen or the CLI; the CLI
     `anonymous` variable; the reconciliation use of the pseudonymous file.
   - **`admin-scopes.md`** — what `export:read` covers, the pseudonymous file's
     `attendees:read`, updated recipes.
   - **`deployment.md` § Teardown** — step 1 offers either path, and step 2's
     checks apply to downloaded files.
   - **`README.md`** — an Admin bullet, the Roadmap line, _After the event_
     usage, the documentation table.
   - **`reviewer-guide.pt-BR.md`**
     - §5.9: what each file identifies, and why names and phones are never on
       the web.
     - §6: the column test against `export-results.sql` and the
       `attendees:read` requirement are deliberate.
     - §7: a checklist item — a new export column is a retention decision:
       SQL, module, test, `data-retention.md`.
     - §10: the index row.
   - **`security-overview.md`** and **`rate-limiting.md`** — the new routes: the
     overview's application controls and the route matrix.
   - **CHANGELOG.**

## To verify in phase 2

- `recordEvent` persists these rows. `deployment.md` says it does not store
  `domain` events, yet the survey override records one; confirm which codes
  persist.
- `::text` matches `COPY` for `timestamptz` under the application connection's
  `TimeZone`; if not, set it for the query.
- `\if :{?anonymous}` works on the psql in the `db` image.
