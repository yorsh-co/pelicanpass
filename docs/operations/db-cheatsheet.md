# Dev Database Cheatsheet

Working directly against the dev Postgres container: opening a shell, connecting
with `psql`, and seeding attendees for manual testing.

Everything here assumes the stack is up (`npm run dev:https`, or
`docker compose up app` for local-only work) and that you are in the repo root.

## Which role for what

Four credentials, each with a different job. Picking the wrong one is the most
likely reason a command in this file fails.

| Role                | Can                                                        | Use it for                        |
| ------------------- | ---------------------------------------------------------- | --------------------------------- |
| `pelicanpass_app`      | `SELECT` and `UPDATE` on named columns of `attendees` only | Nothing by hand — the app uses it |
| `pelicanpass_migrator` | Owns the schema. DDL, and full read/write on every table   | Seeding, editing, migrations      |
| `pelicanpass_readonly` | `SELECT` on everything, and nothing else                   | Browsing, DBeaver, lazysql        |
| superuser           | Everything, including `COPY … FROM PROGRAM`                | Role provisioning only            |

The application role is deliberately unusable for the work in this file: it
cannot `INSERT`, cannot `DELETE`, cannot see `created_at`, and a `SELECT *`
fails against it. That is the point — the app never needs those, so a SQL
injection reaching the database cannot use them either. **Seed and reset as
`pelicanpass_migrator`.**

## Open a psql session

The `db` service already carries every role name and password in its
environment, so nothing needs repeating on the command line. (It deliberately
does not load the whole `.env`; the database has no business holding the tunnel
token or the Turnstile secret. Nor does any other production service: `app` and
`migrate` name their variables too.)

```bash
# day-to-day: seeding, resets, inspection
docker compose exec db sh -c 'psql -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB"'

# read-only browsing
docker compose exec db sh -c 'psql -U "$READONLY_ROLE" -d "$POSTGRES_DB"'

# the superuser, for role provisioning only
docker compose exec db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

The `sh -c` wrapper matters: it makes the container expand the variable. Without
it your own shell expands it, and it is empty locally.

> `POSTGRES_USER` inside the `db` container is the **bootstrap superuser**, not
> the application role. Compose maps `POSTGRES_SUPERUSER` from `.env` onto it,
> because that is the name the `postgres` image insists on. The application's
> own credential is `POSTGRES_USER` in `.env` and `APP_ROLE` in the container.

## Provisioning the roles

`scripts/db/init/01-roles.sh` creates all three least-privilege roles. The
`postgres` image runs it automatically on a **freshly initialised data
directory** — new hosts need nothing. An existing volume never triggers it, so
run it by hand after changing a role password or adopting the scheme on a
database that already has data:

```bash
docker compose exec db sh /docker-entrypoint-initdb.d/01-roles.sh
```

It is idempotent, so re-running it is always safe. Column-level grants on
`attendees` are **not** in that script — they need the table to exist, so they
live in `migrations/005_app-role-grants.ts` and arrive with the migrations.

A plain shell in the container, if you want one:

```bash
docker compose exec db sh
```

Run a single statement and exit — handy in scripts:

```bash
docker compose exec -T db sh -c \
  'psql -U "$MIGRATOR_ROLE" -d "$POSTGRES_DB" -c "SELECT count(*) FROM attendees;"'
```

### psql meta-commands worth knowing

| Command        | Does                               |
| -------------- | ---------------------------------- |
| `\dt`          | List tables                        |
| `\d attendees` | Describe the attendees table       |
| `\x`           | Toggle expanded output (wide rows) |
| `\q`           | Quit                               |

## Seed a test roster

For a populated table rather than a row or two — enough volume to judge the
admin roster's pagination, filters and search, one volunteer for every
combination of `can_redeem`, `redeem_scopes` and `can_draw`, and at least one
for every access tier:

```bash
docker compose exec app node scripts/db/seed.ts --reset
```

Defaults to 40 participants (15 of them checked in, 2 archived) and 10
volunteers. `--count`, `--volunteers`, `--checked-in` and `--archived` change
the shape.

There is an `npm run dev:seed` too, which adds `dotenv` for the times the
environment is not already loaded. It has to run **in a container** for the
same reason `dev:migrate` does — the `data` network is `internal: true`, so
`db` does not resolve from the host:

```bash
docker compose run --rm app npm run dev:seed -- --reset
```

Ticket codes are `st3s00…` for participants and `vt3s00…` for volunteers, and
**the verification code is the last four digits of the phone**, as it is for
every attendee — the seed just makes it predictable: `st3s07` is `1007`,
`vt3s01` is `2001`. So a check-in can be walked end to end without reading
anything back out of the table.

Re-running without `--reset` inserts only what is missing, so it is safe to
repeat. `--reset` deletes **only** rows whose ticket code carries the `t3s`
marker after its key, and only within the current `EVENT_ID` — it cannot remove a row the
real roster put there. It then rewinds `checkin_number_seq` to one past the
highest number still in the table, so a reseeded roster starts calling the
raffle from 1 again instead of drifting upwards.

The script refuses to run when `NODE_ENV` is `production`, or unset — which
`src/config/env.ts` also treats as production. `--force` overrides it.

The ten volunteers it creates, and the tier each pass shows. Every other one, starting with `vt3s00`, is
entitled to lunch; participants never are.

| Ticket    | `can_redeem` | `redeem_scopes` | `can_draw` | `show_admin_link` | `admin_username` | `team`        | `team_role`            | Tier            |
| --------- | ------------ | --------------- | ---------- | ----------------- | ---------------- | ------------- | ---------------------- | --------------- |
| `vt3s00` | true         | all items       | false      | false             | —                | `lojinha`     | `caixa`                | `redeem`        |
| `vt3s01` | true         | `{tshirt}`      | false      | false             | —                | `lojinha`     | `entrega de camisetas` | `redeem`        |
| `vt3s02` | true         | `{meal,drink}`  | false      | false             | —                | `alimentação` | `caixa`                | `redeem`        |
| `vt3s03` | false        | all items       | true       | false             | —                | `comunicação` | —                      | `raffle`        |
| `vt3s04` | true         | all items       | true       | true              | —                | `check-in`    | `validação`            | `redeem`        |
| `vt3s05` | false        | all items       | false      | false             | —                | —             | —                      | `none`          |
| `vt3s06` | false        | all items       | false      | false             | `t3s-edit`       | `secretaria`  | `cadastro`             | `edit`          |
| `vt3s07` | true         | `{meal,drink}`  | false      | false             | `t3s-lookup`     | `check-in`    | `coordenação`          | `lookup`        |
| `vt3s08` | false        | all items       | false      | false             | `t3s-lookup`     | `check-in`    | `consulta`             | `lookup`        |
| `vt3s09` | true         | `{tshirt}`      | false      | false             | `t3s-tshirt`     | `lojinha`     | `camisetas`            | `tshirt`        |

`vt3s05` is the control: a volunteer holding nothing, which the staff surface
must refuse. `vt3s04` is the fullest pass: scanner, raffle and admin links
together, with the questionnaire under them while it is open. The team column
covers each way the line under the name renders: team and role, team only
(`vt3s03`), and the welcome for no team (`vt3s05`). Every volunteer has a
`checkin_time` except `vt3s03` and `vt3s05`: 07:30, 08:00, 08:30, 07:00, 09:00, 08:00, 09:30 and 10:00 in ticket order.

`edit`, `lookup` and `tshirt` are derived from the scopes of the linked
administrator, so the script also upserts three accounts: `t3s-edit`
(`attendees:read`, `attendees:write`), `t3s-lookup` (`attendees:read`,
`checkin:write`) and `t3s-tshirt` (`tshirt:redeem`). They have no usable password — set one with
`scripts/admin/set-admin-password.ts` to sign in as them. `--reset` leaves them
in place, since administrators are not event-scoped; every run restores their
scopes and re-enables them. A roster seeded before these were added needs
`--reset`, or `--volunteers 10`, to gain `vt3s06`…`vt3s09`. `vt3s09` also redeems at a
station, which `tshirt` outranks.

It connects as `pelicanpass_migrator`, for the reason the table at the top of this
file gives — and because `008`, `010` and `011` withhold `UPDATE` on the three
permission columns from `pelicanpass_app` on purpose, so that spread cannot be
written through the application role at all.

Beyond those two accounts it seeds `attendees` only. `redemptions` and `raffle_draws` are left empty, so
the redemption and raffle flows are exercised by using them.

### On the production stack

The commands above do not work against `compose.prod.yml`: the `prod` image ships no
`scripts/db`, so `exec app` fails with `Cannot find module
'/usr/src/app/scripts/db/seed.ts'`. Run it through `migrate` instead, which is
built from the full `build` stage and carries the migrator credentials and
`EVENT_ID` the seed needs:

```bash
docker compose run --rm --build migrate \
  node scripts/db/seed.ts --count 80 --checked-in 30 --force
```

- `--build`, because `docker compose build` never rebuilds `migrate`, so it
  would otherwise run the scripts its last image held.
- `--force`, because `migrate` sets no `NODE_ENV`, and the seed treats that as
  production and refuses. Pass it only on a stack whose database is not the
  live event's.

## Import the roster

The sign-up system's export, a volunteer's `team`, `team_role` and
`checkin_time` included, is loaded with `scripts/db/import-attendees.ts`, and
volunteer permissions in bulk with `scripts/db/set-volunteer-permissions.ts`.
How to run them, the columns each CSV takes, and how to read their reports are
in [`imports.md`](./imports.md).

```bash
npm run dev:import -- --dry-run < roster.csv
npm run dev:permissions -- --dry-run < permissions.csv
```

## Add a test attendee

Five columns have to be supplied. `attendee_id` defaults to a generated UUID,
`checkin_complete` to `false`, and `created_at` to `now()`.

**`event_id` is `NOT NULL` and has no default**, so every insert names it. Use
the same value as `EVENT_ID` in `.env` — every read path filters on it, so a row
carrying anything else is invisible to the application. The omission is a
not-null violation rather than a silent miss, which is the whole reason there is
no default: a second event on this database can never inherit the first one's
rows by accident.

```sql
INSERT INTO attendees (event_id, ticket_code, attendee_name, attendee_phone, attendee_role)
VALUES ('<EVENT_ID from .env>', 'st3st1', 'Test Participant', '5551234567', 'participant')
RETURNING attendee_id, ticket_code;
```

A volunteer, whose ticket codes use their own format:

```sql
INSERT INTO attendees (event_id, ticket_code, attendee_name, attendee_phone, attendee_role)
VALUES ('<EVENT_ID from .env>', 'vt3st1', 'Test Volunteer', '5559876543', 'volunteer');
```

A row belonging to a different event, to prove the scoping holds — the app
should treat it exactly like an unknown ticket:

```sql
INSERT INTO attendees (event_id, ticket_code, attendee_name, attendee_phone, attendee_role)
VALUES ('other-event', 'zz99999', 'Other Event', '5550000000', 'participant');
```

`ticket_link_token` is generated by a column default, so entry links work without
the insert mentioning it. Read it back when you need one:

```sql
SELECT ticket_code, ticket_link_token FROM attendees WHERE ticket_code = 'st3st1';
```

Then visit `/checkin?t=<ticket_link_token>`. The raw ticket code is **not** a
valid entry link — it is only accepted at the manual entry step.

### Field rules the check-in flow enforces

These are validated in `src/modules/checkin/checkin.service.ts`, not by the
schema, so a row that violates them inserts fine and then fails at the ticket
step.

- **`ticket_code`** — exactly six lowercase letters or digits: a one-character
  key followed by five (`/^[a-z0-9]{6}$/`, such as `xabc12`). `v` marks a
  volunteer and `d` a walk-in the attendees editor generated; any other letter
  or digit is the key of a participant from the external sign-up system, with no
  further meaning. Lowercase only; the `attendees_ticket_code_format` check
  constraint (migration `039`) enforces the shape. Unique across the table. The
  patterns live in `src/constants/ticket.ts`, shared by the server, the browser
  and the input's `pattern` attribute.
- **`attendee_phone`** — the **last four digits are the verification code** the
  attendee types in at step two. `5551234567` means the code is `4567`. Store
  digits only; the column is `varchar(20)`. This column is the only place the
  number lives: the check-in session holds no digest of it, and the code is
  compared against the row when it is submitted. Destroyed with the `data`
  volume at teardown, roughly 24 hours after the event — see
  [`data-retention.md`](../security/data-retention.md).
- **`attendee_role`** — a check constraint allows only `participant` or
  `volunteer`.
- **`attendee_name`** — masked in the confirmation preview to first name plus
  last initial, so give it at least two parts to exercise that path.
- **`attendee_nickname`** — set by the attendee, never on insert. Leave it NULL
  and the pass greets them by the first name of `attendee_name`.

`checkin_number` is assigned from the `checkin_number_seq` sequence when
check-in completes; leave it NULL on insert.

## Inspect and reset

Current attendees:

```sql
SELECT ticket_code, attendee_name, attendee_nickname, attendee_phone,
       attendee_role, checkin_complete, checkin_number
FROM attendees
ORDER BY created_at;
```

**Remove a nickname.** The terms of use promise the team can do this. The
attendees editor does it now — `/admin/attendees` → the record → *Remover
apelido*, which needs `attendees:write`. The SQL stays here as the fallback for
when the surface is down, which is what this file is for:

```sql
UPDATE attendees SET attendee_nickname = NULL WHERE ticket_code = 'st3st1';
```

Nothing stops the attendee setting it again straight afterwards. If that
becomes a problem during the event, the escalation is to blank
`attendee_name`'s first token as well, or to take the phone off them; a
`can_rename` flag was deliberately not built ahead of needing it.

Re-run a check-in with the same ticket — this is the one you will use most:

```sql
UPDATE attendees
SET checkin_complete = false,
    checkin_at       = NULL,
    checkin_number   = NULL
WHERE ticket_code = 'st3st1';
```

`updated_at` no longer needs setting by hand: a `BEFORE UPDATE` trigger stamps
it on every write, including this one.

Clear a redemption so it can be tested again. Both statements, not just the
first — the timestamps are the state the pass reads, and `redemptions` is the
audit trail, so clearing only one leaves a re-test starting from stale history:

```sql
UPDATE attendees
SET meal_redeemed_at = NULL, drink_redeemed_at = NULL, tshirt_redeemed_at = NULL,
    lunch_redeemed_at = NULL, tshirt_volunteer_redeemed_at = NULL
WHERE ticket_code = 'st3st1';

DELETE FROM redemptions
WHERE attendee_id = (SELECT attendee_id FROM attendees WHERE ticket_code = 'st3st1');
```

Note `pelicanpass_app` can do neither of these: it holds `INSERT` on `redemptions`
and nothing else, which is what makes the trail append-only. Run them as the
migrator. **On the day, use the redemptions screen instead** — its undo is
audited, and this is not.

Read one attendee's redemption history — every attempt, the corrections, who
made each and why. `redemption_history` is what the redemptions screen calls;
the application role may execute it, and cannot read the table itself:

```sql
SELECT *
FROM redemption_history(
  '<EVENT_ID>',
  (SELECT attendee_id FROM attendees WHERE ticket_code = 'st3st1')
);
```

A `duplicate` row seconds after a `redeemed` one, by the same volunteer, is
usually not a shared screenshot. When a handover's answer times out, the
volunteer slides again, and that second slide is recorded as `duplicate`
although nothing was handed over twice. Their screen shows it as collected.
Two volunteers, or minutes apart, is the case worth asking about.

**Appoint someone who may record retiradas.** For one volunteer, use
`/admin/volunteers` (scope `volunteers:write`), which records who changed what.
For several at once, use the
[permissions import](./imports.md#volunteer-permissions-import). The SQL below
is the fallback, and leaves no audit row. `pelicanpass_app` holds `SELECT` on
`can_redeem` and deliberately **not** `UPDATE`, so the application cannot
promote itself even if it is compromised; the screen writes through the
`set_volunteer_permissions` function from migration `032` instead. Run it as
`pelicanpass_migrator`:

```sql
UPDATE attendees SET can_redeem = true WHERE ticket_code = 'vt3st1';
```

Stand one down the same way:

```sql
UPDATE attendees SET can_redeem = false WHERE ticket_code = 'vt3st1';
```

**Revocation takes effect on that volunteer's next request**, not at their next
login. The permission is re-read from this table on every call to the staff
surface rather than baked into their session, which is what makes standing
someone down mid-event a matter of seconds rather than of waiting out a
24-hour session.

**Put someone on one station only.** `redeem_scopes` narrows what a permitted
volunteer may record, and defaults to every item — so a volunteer set up with the
`can_redeem` recipe above hands over everything, exactly as before this column
existed. Narrowing is opt-in:

```sql
-- The t-shirt table.
UPDATE attendees SET redeem_scopes = ARRAY['tshirt']::text[]
WHERE ticket_code = 'vt3st1';

-- The food table.
UPDATE attendees SET redeem_scopes = ARRAY['meal', 'drink']::text[]
WHERE ticket_code = 'vt3st2';

-- The lunch table.
UPDATE attendees SET redeem_scopes = ARRAY['lunch']::text[]
WHERE ticket_code = 'vt3st3';
```

Move them back to everything the same way:

```sql
UPDATE attendees SET redeem_scopes = ARRAY['tshirt', 'meal', 'drink', 'lunch']::text[]
WHERE ticket_code = 'vt3st1';
```

This takes effect on their next tap, like `can_redeem` and for the same reason —
both come off one row read on every staff request. A volunteer moved between
tables mid-shift with a review card already open is refused the moment they tap
an item that is no longer theirs, and the card tells them to reload.

`redeem_scopes` is **not** a way to stand someone down: an empty array still
leaves them on the staff surface with nothing to hand over. Use `can_redeem`
for that.

**Appoint someone who may run the raffle.** A separate permission from
`can_redeem`, on the same terms — `SELECT` granted, `UPDATE` deliberately not —
because calling numbers from a stage and working a redemption counter are
different jobs. A volunteer may hold either, both or neither:

```sql
UPDATE attendees SET can_draw = true WHERE ticket_code = 'vt3st1';
```

Stand them down the same way, and it takes effect on their next tap for the
same reason as everything above:

```sql
UPDATE attendees SET can_draw = false WHERE ticket_code = 'vt3st1';
```

Who holds what, which is the question asked on the day:

```sql
SELECT ticket_code, attendee_name, can_redeem, redeem_scopes, can_draw
FROM attendees
WHERE attendee_role = 'volunteer'
ORDER BY can_draw DESC, can_redeem DESC, ticket_code;
```

Setting `can_draw` on a participant grants nothing: the gate checks the role
alongside the flag, exactly as the redeem gate does.

**Put a link to the admin area on a volunteer's pass**, for someone who also
holds an `/admin` account. It is only a link and **grants nothing**: `/admin`
asks for its own login, and the attendee session plays no part in it. The pass
reads the flag when the page loads, so it shows up on their next reload:

```sql
UPDATE attendees SET show_admin_link = true WHERE ticket_code = 'vt3st1';
UPDATE attendees SET show_admin_link = false WHERE ticket_code = 'vt3st1';
```

A volunteer whose `admin_username` names an active account gets the link
without the flag, and loses it when that account is disabled. The flag is for an
admin account that isn't linked. Nothing ties it to the account, so clear it by
hand if it was set and the account is disabled: otherwise the link stays and
leads to a login they can no longer pass.

**Link a volunteer to their administrator account.** A label, not a permission:
every admin gate still authenticates against `admins` on its own. Use the
account's lowercase username, which must already exist; `NULL` clears it. Unlike
the import, `UPDATE` does not check that the account exists:

```sql
UPDATE attendees SET admin_username = 'consulta.ana' WHERE ticket_code = 'vt3st1';
```

**Set a volunteer's team and role**, which replace the welcome on their pass.
Free text up to 40 characters, shown as written. A role only shows alongside a
team, and `NULL` clears either one. Like the admin link, it shows on their next
reload:

```sql
UPDATE attendees SET team = 'check-in', team_role = 'validação' WHERE ticket_code = 'vt3st1';
UPDATE attendees SET team = NULL, team_role = NULL WHERE ticket_code = 'vt3st1';
```

**Set a volunteer's arrival time**, `checkin_time`, in whole minutes. Only
volunteers may hold one, it is not shown on the pass, and `NULL` clears it.
Writes made here bypass `set_volunteer_permissions` and leave no audit row:

```sql
UPDATE attendees SET checkin_time = '08:30' WHERE ticket_code = 'vt3st1';
UPDATE attendees SET checkin_time = NULL WHERE ticket_code = 'vt3st1';
```

**Read the ticket limit, or turn it off.** One row per event, and a missing row
means off. Turning it off sets `scope` and keeps the last cap and mode for the
form; the application role cannot `DELETE`, and nor should you:

```sql
SELECT scope, cap, mode, updated_by, updated_at
FROM ticket_limit_state
WHERE event_id = '<EVENT_ID from .env>';

UPDATE ticket_limit_state SET scope = 'off', updated_at = now()
WHERE event_id = '<EVENT_ID from .env>';
```

**Clear the redemption audit for a test attendee** — see "Clear a redemption"
above, which now takes two statements.

Drop a test row:

```sql
DELETE FROM attendees WHERE ticket_code = 'st3st1';
```

Wipe every attendee and restart check-in numbering from 1:

```sql
TRUNCATE attendees, redemptions, raffle_draws;
ALTER SEQUENCE checkin_number_seq RESTART WITH 1;
```

`redemptions` is truncated alongside because it holds `attendee_id` values with
no foreign key to enforce the link — truncating `attendees` alone would leave
audit rows pointing at nobody, and they would not be an error, just wrong.
`raffle_draws` goes with them for the same reason twice over: it holds
`attendee_id` in `drawn_by`, and it holds `checkin_number` values that the
sequence restart is about to hand out again.

Check where the sequence currently sits (`is_called = f` means nothing has been
drawn yet, so the next value is `last_value` itself):

```sql
SELECT last_value, is_called FROM checkin_number_seq;
```

## Administrators

**Use the scripts, not SQL.** `scripts/admin/` covers creating an account,
listing the roster, changing scopes, disabling someone and resetting a password
— see [`deployment.md`](./deployment.md). A password in particular cannot be set
here: it has to be run through scrypt with the pepper from the environment, so a
hand-written `UPDATE` would store something no login can ever verify.

Read-only inspection is fair game. Note that `password_hash` is deliberately
absent from this projection — there is no reason to put one on a terminal:

```sql
SELECT username, admin_scopes, is_active, last_login_at
FROM admins
ORDER BY username;
```

`pelicanpass_app` holds `SELECT` on five columns and `UPDATE` on `last_login_at`
and `updated_at` — no `INSERT`, no `DELETE`. That is what stops anything
reachable from a request minting an administrator, and it is why provisioning
runs as `pelicanpass_migrator`. Confirm it with:

```sql
SELECT privilege_type, column_name
FROM information_schema.column_privileges
WHERE table_name = 'admins' AND grantee = 'pelicanpass_app'
ORDER BY privilege_type, column_name;
```

## The raffle

The draw reads every `checkin_number` of a completed check-in — so the pool is
the participants, and volunteers are excluded by having no number at all.

What has been called, and what was put back:

```sql
SELECT checkin_number, created_at, cleared_at
FROM raffle_draws
ORDER BY created_at;
```

**A reset does not delete the row**, it stamps `cleared_at` and `cleared_by`.
Every read filters on `cleared_at IS NULL`, so the number returns to the pool
while the record of it having been called survives — `pelicanpass_app` holds no
`DELETE` on this table at all, which is what makes that guarantee structural
rather than a convention. Only the uncleared rows are on the operator's screen:

```sql
SELECT checkin_number, created_at
FROM raffle_draws
WHERE cleared_at IS NULL
ORDER BY created_at DESC;
```

Put a number back by hand, if the page cannot:

```sql
UPDATE raffle_draws SET cleared_at = now()
WHERE checkin_number = 42 AND cleared_at IS NULL;
```

**Start the raffle over.** There is no "reset all" on the page — one mis-tap
would undo an evening — so it is this, and it clears the trail with it:

```sql
DELETE FROM raffle_draws;
```

Or keep the history and merely stand every number back up:

```sql
UPDATE raffle_draws SET cleared_at = now()
WHERE cleared_at IS NULL;
```

## Notes

- The attendee's session lives in **Redis**, not Postgres. Editing a row
  mid-flow will not reset a check-in already in progress — clear the browser
  cookies, or use a private window.
- Confirming the privilege boundary still holds — every one of these must be
  denied, and the last two are the ones worth re-checking after any migration
  that touches `attendees`:

  ```bash
  docker compose exec -T db sh -c 'psql -U "$APP_ROLE" -d "$POSTGRES_DB"' <<'SQL'
  COPY (SELECT 1) TO PROGRAM 'id';          -- the finding: superuser RCE
  UPDATE attendees SET attendee_phone = 'x';
  DELETE FROM attendees;
  SELECT * FROM attendees;                  -- created_at/updated_at ungranted
  CREATE TABLE scratch (i int);
  SQL
  ```

- Migration state is in the `pgmigrations` table, owned by `pelicanpass_migrator`.
  `npm run migrate` builds its `DATABASE_URL` from `POSTGRES_MIGRATOR_USER` —
  the application's credential cannot run migrations and is not meant to.

  ```bash
  # development
  docker compose run --rm app npm run dev:migrate

  # production
  docker compose -f compose.prod.yml --profile tools run --rm --build migrate
  ```

  Run these **in a container, not from the host**: the `data` network is
  `internal: true`, so `db` does not resolve outside the compose stack. The two
  paths differ because `node-pg-migrate` is a devDependency and the production
  runtime image is pruned — migrations get their own image stage instead.

- The `data` volume survives `docker compose down`. Losing it takes
  `docker compose down -v`, which also drops `cache` and `node_modules`.
