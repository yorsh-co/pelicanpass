# CSV Imports

Two scripts load a CSV into `attendees` for the current event:

| Script                                    | Loads                                                          | Never touches                   |
| ----------------------------------------- | -------------------------------------------------------------- | ------------------------------- |
| `scripts/db/import-attendees.ts`          | The sign-up system's roster: codes, names, phones, items, and a volunteer's team and check-in time | Volunteer permissions           |
| `scripts/db/set-volunteer-permissions.ts` | `can_redeem`, `redeem_scopes`, `can_draw`, `show_admin_link`, `admin_username` | Anything but those five columns |

They are separate on purpose. Re-importing the roster from the sign-up system
can never change who is allowed to record retiradas or run the raffle.

## Running either import

Both behave the same way:

- **The file is read from stdin**, so it never has to be copied into the
  container. Run from the repo root with `-T`: `docker compose exec` needs it
  to pass redirected input through.
- **`EVENT_ID` must be set.** It already is in the container's environment.
  Only rows under that event are read or written.
- **Connects as `pelicanpass_migrator`.** The application role cannot write
  permission columns, and nothing here goes through the app.
- **All or nothing.** Every row is validated and planned inside one
  transaction before the first write. Any problem rolls the whole file back
  and exits `1` with `Nothing imported` / `Nothing written`.
- **`--dry-run` first.** It does everything, prints the same report, and rolls
  back. Read the report, then run it again without the flag.
- **Reports never contain names or phone numbers**, only line numbers and
  ticket codes, so you can paste one into a chat.

Production:

```bash
docker compose -f compose.prod.yml run --rm -T migrate node scripts/db/import-attendees.ts --dry-run < roster.csv
docker compose -f compose.prod.yml run --rm -T migrate node scripts/db/import-attendees.ts < roster.csv

docker compose -f compose.prod.yml run --rm -T migrate node scripts/db/set-volunteer-permissions.ts --dry-run < permissions.csv
docker compose -f compose.prod.yml run --rm -T migrate node scripts/db/set-volunteer-permissions.ts < permissions.csv
```

Both connect as the migrator role, so they run in the `migrate` service, which holds
those credentials and `EVENT_ID` and none of the server's secrets. `run` reuses the
last built image: add `--build` after a pull. `-T` is required because the CSV
arrives on stdin.

Development, against the `.env` on the host:

```bash
npm run dev:import -- --dry-run < roster.csv
npm run dev:permissions -- --dry-run < permissions.csv
```

**File format, for both.** UTF-8, comma-separated, first line is the header.
Header names are case-insensitive and can come in any order. An unknown or
repeated header refuses the file. A byte-order mark, CRLF line endings, blank
lines and quoted cells (`"Lima, Ana"`) are all accepted, so "CSV UTF-8" from
Excel or Google Sheets loads as-is. Cells are trimmed.

**Input limits.** Both importers refuse, before parsing and with nothing
written, input over **2 MB** (reading stops there) or with more than **5,000
data rows**: non-blank lines after the header, so a quoted cell spanning lines
counts each line. A **NUL byte** is refused too, as `line N: contains a NUL
byte`, rather than stripped; export the file again as plain CSV UTF-8. The
byte-order mark is still accepted. A roster is a few hundred rows, so these
bounds only catch a wrong or broken file.

**Formula cells are refused.** A text cell that starts with `=`, `+`, `-`, `@`,
a tab or a carriage return, as written and again after trimming, refuses the
whole file with `line N (code): <column> starts with a character spreadsheets
read as a formula`, in `--dry-run` as well. These values reach the exports
unchanged, and a spreadsheet would evaluate them. Which columns are checked:

- **Roster:** `name`, `meal_option`, `drink_option`, `tshirt_size`,
  `lunch_option`, `tshirt_volunteer_size`, `team` and `team_role`. A real name
  or label never starts that way; an option that does is off the approved list
  anyway.
- **Roster, not checked:** `phone`, because only its digits are kept and a
  leading `+55` is normal; `ticket_code`, `role` and `checkin_time`, which are
  held to a fixed shape.
- **Permissions:** every column. Their shapes already refuse `=` and `@`; the
  check adds the leading tab or CR that trimming would hide, and a username
  starting with `+` or `-`.

Fix the cell in the source, or prefix it with a letter, and load again. The
admin editor applies the same rule through its approved-option lists.

## Roster import

`scripts/db/import-attendees.ts`

### Columns

`ticket_code`, `name` and `phone` are required headers. The rest may be left
out of the header, or left blank.

| Header         | Required | Accepts                                                                                                                                                                | Blank means                                                       | Example               |
| -------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| `ticket_code`  | yes      | Exactly 6 characters, lowercase letters or digits: a one-character key followed by the 5 the external sign-up system issues; **add the key before import**, since the importer only validates. Volunteers use the key `v`. `d` is reserved for walk-ins the attendees editor creates and is refused. Any other letter or digit is a participant key. Upper case is lowered. | refused | `xabc12`, `7abc12`, `vabc12` |
| `name`         | yes      | Up to 120 characters, at least one letter. Runs of whitespace collapse to one space.                                                                                   | refused                                                           | `Ana Lima`            |
| `phone`        | yes      | 10–15 digits once punctuation is stripped. **The last four digits are the attendee's verification code.**                                                              | refused                                                           | `+55 (11) 90000-1234` |
| `role`         | no       | `participant` or `volunteer`. It must agree with the code: only `v` codes are volunteers.                                                                              | taken from the code: `v` is a volunteer, anything else a participant | `volunteer`           |
| `meal_option`  | no       | Up to 60 characters. Should match the approved list in `src/web/content/redemption-options.md` exactly. An off-list value loads with a warning.                        | not entitled to a meal                                            | `Hambúrguer de Carne` |
| `drink_option` | no       | As `meal_option`, for the drink.                                                                                                                                       | not entitled to a drink                                           |                       |
| `tshirt_size`  | no       | As `meal_option`, for the t-shirt.                                                                                                                                     | not entitled to a t-shirt                                         | `M - Preto`           |
| `lunch_option` | no       | As `meal_option`, for lunch. **Volunteers only**: a participant row with a value is refused.                                                                            | not entitled to lunch                                             | `Almoço`              |
| `tshirt_volunteer_size` | no | As `meal_option`, for the volunteer t-shirt, a separate item from `tshirt_size`. **Volunteers only**: a participant row with a value is refused. | not entitled to a volunteer t-shirt | `G - Roxa` |
| `team` | no | Free text, up to 40 characters, shown on their pass as written. **Volunteers only**: a participant row with a value is refused. | clears it | `check-in` |
| `team_role` | no | Their role in that team, as `team`. Only shown alongside a team. **Volunteers only**, as `team` | clears it | `validação` |
| `checkin_time` | no | The time of day they should arrive on event day, 24-hour `HH:MM` (`H:MM` is accepted and padded). Not shown on the pass. **Volunteers only**, as `team` | clears it | `08:30` |

A blank role is taken from the key alone: a `v` code is a volunteer, any other
a participant. A `v` code under the `participant` role is refused. Rekey
volunteers as `v` before import.

Every row is also held to the attendee editor's rules; see
[Field rules the check-in flow enforces](./db-cheatsheet.md#field-rules-the-check-in-flow-enforces).

An option column left out of the header reads as blank on every row. If lunch
or a volunteer t-shirt was assigned in the editor rather than in the roster,
re-importing a file without `lunch_option` or `tshirt_volunteer_size` clears it
on every volunteer the file updates. Include the column, or re-assign it
afterwards. A collected item is never cleared: the row is refused instead.

`team`, `team_role` and `checkin_time` are different: when their header is
absent they are not touched, and only a blank cell under a present header
clears. `/admin/volunteers` edits them too, and re-importing a file that has
the column overwrites an editor change, as it does for lunch.

### Generating ticket codes

When the roster has no codes yet, print some to paste into the `ticket_code`
column before import:

```sh
npm run codes -- 20      # 20 codes starting with "a"
npm run codes -- 20 v    # 20 volunteer codes
```

The key defaults to `a`. `d` is refused: it is reserved for walk-ins the
attendees editor creates, and the importer rejects it. Any key other than `v` is
a participant key and prints a warning on stderr: if the external sign-up system
also issues codes under that key, a later roster may reuse one of these, and the
import treats both as the same attendee. Codes are unique within a run only, so
run it once per roster and keep the output. A code already on the roster shows
up in the import's change report as an update to that attendee.

### Example

```csv
ticket_code,name,phone,role,meal_option,drink_option,tshirt_size,lunch_option,tshirt_volunteer_size,team,team_role,checkin_time
xabc12,Ana Lima,+55 (11) 90000-1234,,Hambúrguer de Carne,,M - Preto,,,,,
vab123,Bruno Souza,11 98888-7777,volunteer,,,G - Preto,Almoço,G - Roxa,check-in,validação,08:30
```

### Team and role on the pass

On a volunteer's pass, `team` and `team_role` replace the welcome line under the
name, as `check-in · validação`. With a team and no role, only the team shows.
With no team, the welcome shows, even if a role is set. Participants always see
the welcome, and the import refuses these columns for them.

Values are shown exactly as typed. Keep one spelling per team across the file.
Whitespace runs collapse to one space, and case is kept. A change appears the
next time the pass loads.

### Re-importing

`ticket_code` is the identity, so loading the same file twice changes nothing,
and a corrected file changes only what differs:

| The code is…                     | The import…                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| new                              | inserts it, with a fresh entry-link token                                                    |
| known, and a field differs       | updates only `attendee_name`, `attendee_phone`, the option columns and the team columns the header names |
| known, and nothing differs       | leaves it alone. Whitespace and phone punctuation are normalised before comparing            |
| in the table but not in the file | lists it and leaves it alone. Archive a cancellation in the editor                           |
| held by another event            | refuses the whole file                                                                       |

It never touches check-in state, `checkin_number`, a nickname, `archived_at`,
redemptions, the volunteer permission columns or the entry-link token. A new
volunteer starts with `can_redeem` and `can_draw` off. Use the
[permissions import](#volunteer-permissions-import) to appoint them.

It also refuses the whole file for:

- a role change
- a blank option whose item was already collected. That's the editor's rule,
  and it keeps the roster agreeing with `redemptions`.

### Reading the report

| Section                                   | Meaning                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------- |
| `Updated`                                 | Each changed code, with the fields that changed                                       |
| `Phone changed — the verification code…`  | Tell these attendees: the code they type at check-in has changed                      |
| `Updated after check-in`                  | Already checked in. The change applies to their pass from now on                      |
| `Updated while archived — still archived` | The row was updated, but it stays archived until someone un-archives it in the editor |
| `Not in this file — left unchanged…`      | Probably cancellations. Archive them in the editor if so                              |
| `Warnings`                                | Off-list options. They were loaded anyway                                             |
| `Problems`                                | Why nothing was imported, including a cell that starts like a formula               |

## Volunteer permissions import

`scripts/db/set-volunteer-permissions.ts`

Each volunteer must already exist, so load them with the roster import first.

For one volunteer, `/admin/volunteers` (scope `volunteers:write`) edits every
column below except `admin_username`, plus `team`, `team_role` and
`checkin_time`, and records each change with who made
it. This import stays the way to load many volunteers at once and the only way
to set `admin_username`. Its writes run as the migrator and are not recorded in
that history.

### Columns

`ticket_code` is required, plus **at least one** permission column.
**A permission column left out of the header is not touched**. For example,
`ticket_code,can_draw` grants the raffle and leaves redemption settings as they
are. A volunteer left out of the file is not touched either: this sets what the
file lists and doesn't sync the whole set.

When a column is in the header, every row must fill it. A blank cell is refused,
never read as "unchanged" or "false". The exception is `admin_username`, where a blank
cell clears the link.

`team`, `team_role` and `checkin_time` are loaded by the
[roster import](#roster-import). A file that names them is refused.

| Header          | Required | Accepts                                                                                                         | Example      |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------- | ------------ |
| `ticket_code`   | yes      | A volunteer code, `v` followed by 5 lowercase letters or digits. It must exist under this event as a volunteer | `vab123`    |
| `can_redeem`    | no       | `true` or `false`. Whether they may record retiradas at all                                                     | `true`       |
| `redeem_scopes` | no       | Items they may record, separated by `;`: `tshirt`, `tshirt_volunteer`, `meal`, `drink`, `lunch`. Or `none`                          | `meal;drink` |
| `can_draw`      | no       | `true` or `false`. Whether they may run the raffle                                                              | `false`      |
| `show_admin_link` | no     | `true` or `false`. Whether their pass links to `/admin`. Only needed for an admin account that isn't linked: a volunteer whose `admin_username` names an active account gets the link anyway. A link only: `/admin` still asks for its own login | `false`      |
| `admin_username` | no      | The username of their `/admin` account, lowercased on load. It must match an existing administrator; an unknown one is refused, and a disabled one is loaded with a warning. A label only: `/admin` still asks for its own login. It also lets the pass show their [access tier](../features/admin-scopes.md#pass-access-tiers). Blank clears it | `consulta.ana`     |

Values replace what is stored; they are not merged. `redeem_scopes` only narrows
`can_redeem`. It has no effect while `can_redeem` is `false`, and `none` doesn't
stand a volunteer down: they stay on the staff surface with nothing to hand
over. To stand them down, set `can_redeem` to `false`. A new volunteer's scopes
default to every item, lunch and the volunteer t-shirt included.

### Example

```csv
ticket_code,can_redeem,redeem_scopes,can_draw,show_admin_link,admin_username
vab123,true,tshirt,false,false,
vcd456,true,meal;drink,false,false,
vef789,false,tshirt;meal;drink,true,false,
vgh012,true,tshirt;meal;drink,true,true,consulta.ana
```

`vab123` works the t-shirt table, `vcd456` the food table, and `vef789` only
runs the raffle. `vgh012` does both and also holds an admin account, so their
pass links to `/admin` as well and is linked to the `consulta.ana` account.

### When it takes effect

Permissions are re-read from the database on every staff request, so a change
applies on that volunteer's next tap. They don't need to log in again. A
volunteer mid-review at a table they were just moved off is refused on their
next tap and told to reload.

`show_admin_link` is different. It only changes what
the pass shows, so the change appears the next time the pass loads. The admin
link also follows a linked account's `is_active` the same way.
`admin_username` also changes what the pass shows, but its
[access tier](../features/admin-scopes.md#pass-access-tiers) is re-sent on every pass
poll, so it follows within about 30 seconds on a pass that is open. Clearing any
of them is not reported under `Access removed`, because they never granted
access.

### Reading the report

| Section                                   | Meaning                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `Updated`                                 | Each changed code, as `field old → new`                                                   |
| `Access removed — takes effect…`          | They lost the raffle, or an item they could record. Tell them before their next tap       |
| `Warnings`                                | An `admin_username` whose account is disabled. It was loaded anyway                       |
| `Updated while archived — still archived` | Written. The row stays archived until someone un-archives it in the editor                |
| `Problems`                                | Why nothing was written: an unknown code, another event's code, a participant, a bad cell, an `admin_username` no administrator holds |

Re-running the same file reports `0 updated`.

To check who holds what afterwards, run the read-back query in
[`db-cheatsheet.md`](./db-cheatsheet.md#inspect-and-reset). To change one
volunteer by hand, the single-row `UPDATE` recipes are there too.
