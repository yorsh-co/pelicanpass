# Data Retention

What personal data this application holds, why it holds it, and when it goes.

Written for LGPD purposes. If someone asks what happens to attendee data after
the event, this is the answer.

## The deployment ends, and that is the policy

**The host is torn down roughly 24 hours after the event.** `docker compose down -v`
destroys the `data` volume, and every phone number and name goes with it. There
is no 30-day calendar entry to keep, because there is no server to run it on.

That makes retention a question about **what leaves the box before it goes**,
not about what is scheduled on it afterwards:

| Artifact                          | Lives                                                    |
| --------------------------------- | -------------------------------------------------------- |
| `attendee_phone`, `attendee_name`, `attendee_nickname` | Destroyed with the `data` volume, ~24 h after the event |
| `team`, `team_role`               | Destroyed with the `data` volume, ~24 h after the event |
| `checkin_time`                    | Destroyed with the `data` volume, ~24 h after the event |
| Redis sessions                    | Self-expiring, ≤24 h — gone with the host either way     |
| Container logs (stdout)           | Destroyed with the containers                            |
| **`warn`+ log file**              | **Survives a recreate** — on the `logs` volume, destroyed by `down -v` |
| `app_events`                      | Destroyed with the `data` volume, ~24 h after the event |
| `whatsapp_runs`, `whatsapp_sends` | Destroyed with the `data` volume, ~24 h after the event |
| `whatsapp_door_sends`, `whatsapp_door_state` | Destroyed with the `data` volume, ~24 h after the event |
| `survey_completions`, `survey_state` | Deleted by `purge-attendees.sql` before the exports; the rest with the `data` volume |
| `volunteer_permission_changes`    | Deleted by `purge-attendees.sql`; the rest with the `data` volume |
| `pass_welcome_state`              | Destroyed with the `data` volume, ~24 h after the event |
| **Redacted results export**       | **Keepable indefinitely** — carries no phone and no name |
| **Survey answers, one CSV per audience** | **Keepable indefinitely** — anonymous; see below |
| **Traffic summary**               | **Keepable indefinitely** — counts, minutes and normalised routes; no address, user agent or token |
| A full `pg_dump`                  | **Must not outlive the host.** See below                 |
| Standby snapshots, cut-back tars, `pre-restore-*.dump` | **Must not outlive the host.** Full copies of Postgres and Redis in `~/standby` on dev-server and prod-server, `0600`; deleted at teardown with dev-server's standby volumes. See [`standby.md`](../operations/standby.md) § 9 |

Exactly two kinds of artifact are meant to survive: `scripts/db/export-results.sql`, and the
questionnaire's answers from `scripts/survey/export-csv.ts`, one file per audience.

### The dump is the thing that gets this wrong

`deployment.md` tells you to `pg_dump` before the event and before any schema
change. That is right, and those dumps contain every attendee's phone number in
plaintext. A dump copied to a laptop "just in case" outlives the host, and with
it the obligation — except that nothing is left to enforce.

So, before teardown, one of:

- **Delete the dumps.** The default, and what the runbook says.
- **Or run `scripts/db/purge-phone.sql` first, then dump.** If a full backup has
  to be kept, this is what makes keeping it defensible.

The purge scripts are not obsolete. They stop being a scheduled job and become
the guard on a retained dump, plus the early-erasure path for a deletion request
before the event.

## What is held

| Data                | Where               | Purpose                                  | Retention                               |
| ------------------- | ------------------- | ---------------------------------------- | --------------------------------------- |
| `attendee_phone`    | Postgres, plaintext | Identity verification at the door; last four digits read back at the volunteer lookup | Destroyed at teardown, ~24 h post-event |
| `attendee_name`     | Postgres, plaintext | Confirming the right person checked in   | Destroyed at teardown                   |
| `attendee_nickname` | Postgres, plaintext | The name the attendee chose for their pass | Destroyed at teardown; never exported |
| `team`, `team_role` | Postgres, plaintext | Where a volunteer serves, from the coordinators' CSV; shown only on their own pass | Destroyed at teardown; never exported; redacted early by `purge-attendees.sql` |
| `checkin_time`      | Postgres, plaintext | When a volunteer should arrive on event day, from the coordinators' CSV or the admin screen; never shown on the pass, never exported | Destroyed at teardown |
| `ticket_code`       | Postgres            | The credential an attendee presents      | Survives in the export — see below      |
| `ticket_link_token` | Postgres            | Credential the printed QR link carries   | Destroyed at teardown; never exported   |
| `archived_at`       | Postgres            | When a registration was retired from the event | Destroyed at teardown; **is** exported — see below |
| `attendee_role`     | Postgres            | Participant vs volunteer routing         | Survives in the export; not personal    |
| `meal_option`, `drink_option`, `tshirt_size`, `lunch_option` | Postgres | What the attendee registered to collect, from the [approved list](../features/redemption-options.md) | Destroyed at teardown; **is** exported — see below |
| `meal_redeemed_at`, `drink_redeemed_at`, `tshirt_redeemed_at`, `lunch_redeemed_at` | Postgres | Whether and when each item was collected | Destroyed at teardown; **is** exported — see below |
| `redemptions`       | Postgres            | The audit trail: every attempt, including who was refused and which volunteer served them | Destroyed at teardown; the **table** is not exported — but see below |
| `raffle_draws`      | Postgres            | Which numbers the raffle called, and which were put back | Destroyed at teardown; not exported |
| Check-in session    | Redis               | The in-progress flow                     | **15 minutes**, self-expiring           |
| Attendee session    | Redis               | Post-check-in access to their own record | **24 hours**, self-expiring             |
| Attendee session pointer | Redis          | Names the attendee's newest session so older ones can be revoked | **24 hours**, self-expiring |
| Spent pass tokens   | Redis               | Stops a scanned pass being scanned twice | **120 seconds**, self-expiring          |
| Staff review handles| Redis               | Links a scan to the redemption after it  | **120 seconds**, self-expiring          |
| Idempotency records | Redis               | Replays an attendee create or a raffle draw re-sent after a timeout, instead of repeating it. Holds the response: a create's attendee ID, ticket code and door-message outcome, or a draw's view | **60 seconds** while running, **10 minutes** once done, self-expiring |
| **Limiter busiest-keys sets** | Redis, sorted set | Which addresses or sessions are closest to a rate-limit ceiling — the panel that answers "is CGNAT the problem" | **5 minutes**, self-expiring |
| **Per-address session fan-out** | Redis, HyperLogLog | How many distinct sessions one address carries. The discriminator between a carrier NAT and an attacker | **5 minutes**, self-expiring |
| Request logs        | Container stdout    | Operations, and the teardown's anonymous traffic summary | Container lifetime, capped by `json-file` rotation at 200 MB for the app and 50 MB for every other container |
| **`warn`+ log lines** | **`logs` volume, rotating NDJSON** | The durable operational record: a mid-event `--force-recreate` no longer discards it | Destroyed by `docker compose down -v` at teardown, with the `data` volume |
| `app_events.ip`     | Postgres            | Which address produced an error or tripped a limiter — the CGNAT and abuse signal | Destroyed at teardown; redacted early by `purge-attendees.sql` |
| `app_events.actor_id` | Postgres          | Attributing a failure to a session without naming anybody: a 16-hex digest of the session ID, never the ID itself (an admin's own actions carry their `admin_id`) | Destroyed at teardown; redacted early by `purge-attendees.sql` |
| `app_events.context` | Postgres, jsonb    | Scrubbed detail attached to an occurrence | Destroyed at teardown; redacted early by `purge-attendees.sql` |
| `whatsapp_sends.to_e164` | Postgres       | The number a template was sent to        | Destroyed at teardown; redacted early by both purge scripts |
| `whatsapp_sends.wa_id` | Postgres         | The number Meta canonicalised it to, which receipts arrive on | Destroyed at teardown; redacted early by both purge scripts |
| `whatsapp_sends.wamid` | Postgres         | Joins a delivery receipt to its send; Meta can join it to a number | Destroyed at teardown; redacted early by `purge-attendees.sql` |
| `whatsapp_sends.error_detail` | Postgres  | Meta's free-text refusal reason, which can quote a number | Destroyed at teardown; redacted early by `purge-attendees.sql` |
| `whatsapp_sends.delivered_at`, `read_at` | Postgres | When Meta reported the message delivered, and when the recipient read it — behavioural data about a named person, not an operational timestamp | Destroyed at teardown; not redacted, and still joined to the attendee through `attendee_id` |
| `whatsapp_sends.attendee_id` | Postgres   | Which attendee a send was for, and the no-double-send key | Destroyed at teardown; not redacted, like `redemptions` |
| `whatsapp_door_sends.to_e164` | Postgres  | The number a door message was sent to, and the one-message-per-number key | Destroyed at teardown; redacted early by both purge scripts |
| `whatsapp_door_sends.wamid` | Postgres    | Meta's id for a door message; Meta can join it to a number | Destroyed at teardown; redacted early by `purge-attendees.sql` |
| `whatsapp_door_sends.attendee_id` | Postgres | Which attendee a door message was for, and the per-attendee cap's key | Destroyed at teardown; not redacted, like `whatsapp_sends.attendee_id` |
| `whatsapp_door_state` | Postgres          | The door message switch, and the admin id of whoever last flipped it | Destroyed at teardown; not attendee data |
| `survey_completions.attendee_id` | Postgres | That an attendee has answered the questionnaire, and nothing else: the one-response guard | Deleted by `purge-attendees.sql`, which also closes the questionnaire; never exported |
| `survey_responses`  | Postgres            | The questionnaire's answers and the audience they were given under — no attendee, no timestamp | Survives in the per-audience CSVs, **anonymous** — see below |
| `survey_state`      | Postgres            | The questionnaire's override, and the admin id of whoever set it | Destroyed at teardown; not attendee data |
| `pass_welcome_state` | Postgres           | The welcome schedule saved at `/admin/pass`, and the admin id of whoever saved it | Destroyed at teardown; not attendee data |
| `volunteer_permission_changes` | Postgres | Who changed a volunteer's permissions and when: `attendee_id`, the editing `admin_id`, and the before and after of the team and role labels | Deleted by `purge-attendees.sql`; otherwise destroyed at teardown; never exported |
| `admins.username`   | Postgres            | An administrator's sign-in name, which may be their email address. Also carried by the `warn`+ log lines for a refused or budget-exhausted sign-in, deliberately never by an alert | Destroyed at teardown, with the `logs` volume for the log lines |
| **Volunteer email addresses** | Cloudflare Access — the policy and its per-request logs | Who may reach `/admin`, and which of them did | **Cloudflare's, not ours.** Read the window from Zero Trust → Logs before the event and record it here. Removing an address from the policy ends the access; it does not clear the log |

**Attendee replies to a WhatsApp message reach this host and are discarded unread.** They arrive on
the same Meta webhook field as delivery receipts, and there is no setting that takes one without the
other. The receiver reads only the status array: a reply's text, sender and timestamp are not stored,
logged or counted.

The two metrics keys above are the only place an address is held outside
`app_events` and the log file. Both are keyed by IP, both expire in five minutes,
and neither survives the host. They are read on the admin surface and **never
leave it**: the fan-out alert that reaches Discord names a truncated
hash, and the operator looks the address up on the dashboard rather than being
told it in a channel. That split is deliberate — an alert is a message in a chat
history nobody purges, and a dashboard is a screen.

### The export is pseudonymous, not anonymous

`ticket_code` is in the export, and it re-identifies against the organiser's own
roster — the spreadsheet or CSV the attendees came from, which lives outside
this system and has its own lifecycle. The export is therefore still personal
data in LGPD terms for as long as that roster exists.

It is included because per-attendee reconciliation is the point: who was
expected and did not arrive, who redeemed a meal. Dropping that one column from
`export-results.sql` makes the file genuinely anonymous — counts and timings
with nobody attached. Decide which of the two you are producing before sharing
it, and say so to whoever receives it.

The post-event report built from these files (`npm run report`, see
[`event-report.md`](../operations/event-report.md)) drops `ticket_code` as it reads. Its data-mode HTML
still carries the survey free text and the church and sale date (date only, no time) of each attendee row, so treat it as organiser-only:
`reports/` is git-ignored. From an optional `age` column it keeps single-year ages for 13 to 18 and collapses the rest into ≤12 and 19+, never an exact age outside 13 to 18.

**What `ticket_code` re-identifies is more than a check-in time.** The six
redemption columns are in the export beside it, so the surviving file says, per
attendee, what they registered to collect and whether and when they collected
it. That is the whole point of keeping the code — but it means the answer to
"does redemption data outlive the deployment?" is *yes*, and the row above
saying `redemptions` is not exported is answering a narrower question than the
one a reader is likely asking.

The distinction that holds: the **audit trail** dies with the volume. Who served
whom, and every refusal, lives only in `redemptions` and in the container logs,
and neither leaves the box. The **fact of collection** lives on the attendee row
and survives in the CSV. A deletion request arriving after teardown therefore
still has something to answer for — see the last section.

### The survey export is anonymous

Unlike the results export, the questionnaire's CSVs carry nothing that joins an answer to a
person, and that is a property of the schema rather than of the export.

- **Answering and the answers are two tables with nothing joining them.** `survey_completions`
  records who answered, and nothing else. `survey_responses` holds the answers, with no attendee
  column.
- **Nothing orders or times a response.** `response_id` is a random uuid rather than a serial, and
  `submitted_on` is a date rather than a timestamp. An order or a precise time would join to the
  request log, to `app_events` or to a check-in time.
- **The system columns are withheld.** A completion and its response are written in one
  transaction, so they share an `xmin`, and `ctid` order is insertion order. Any role with
  table-level `SELECT` could pair them through those. Migration 020 revokes the read-only role's
  default `SELECT` on both tables, and the application role never had it on the answers. Both read
  answers only through the `survey_export` view, which projects neither column. The migrator and
  the superuser can still read them until `purge-attendees.sql` deletes the completions or the host
  is torn down.
- **The export orders by `response_id`**, so no file reproduces insertion order.

What the schema cannot do, stated so that nobody promises more:

- **Small numbers identify.** A handful of answers on a given day is a handful of people.
- **Free text is the author's own.** An answer that names its writer is signed.
- **The volunteer file is far easier to re-identify by reading.** Volunteers are few, known by
  name, and describe shifts and stations only some of them worked. The volunteer form and
  `/admin/survey` both say so.

So the survey CSVs are anonymous in the sense that matters for retention, and can be kept. Share the
volunteer file as you would a note that could be traced to a small group.

### Why the phone number exists at all

The last four digits are the verification code. An attendee proves the ticket is
theirs by supplying them, which is the only thing standing between a guessed
six-character ticket code and someone else's check-in. Nothing else in the
record is a shared secret, so the number is load-bearing for the length of the
event and dead weight the moment the doors close.

**It is never stored anywhere but the `attendees` table.** The check-in session
holds no digest of it — the code is checked against the row at the instant it is
submitted (`verifyAttendee` in `checkin.service.ts`). A Redis dump contains
nothing that can be turned back into a phone number.

### The one exposure that is accepted

`attendeePreview.phoneStart` is in the session for its lifetime, and it is
plaintext. `maskPhone` drops the last six digits, so an 11-digit Brazilian
mobile leaves five visible: `11987654321` → `11987`.

That is deliberate. The preview is what lets an attendee confirm the record is
theirs before verifying, and without it the confirmation step is meaningless.
Five leading digits are the area code and carrier prefix — shared by everyone in
the same city on the same network, so on their own they identify nobody.

What made this worth writing down is that it used to sit next to a SHA-256 of
the last four digits in the same JSON value. Ten thousand candidates is not a
hash, it is a lookup table, and the two together gave up nine of eleven digits.
The digest is gone; the preview stays. It is bounded by the check-in session's
fifteen-minute TTL and by being the only phone-derived value left in Redis. Note
that this is the _check-in_ session, not the attendee session — the preview is
discarded when the session is rotated at verification, so it never reaches the
24-hour window.

Request logs record `attendeeId`, `checkinNumber`, `attendeeRole` and `source` —
never a name, a phone number and, with one exception, never a ticket code. The
exception is `AdminAttendeesService.#created`, which logs the code an operator
just minted: it is issued at that instant and nowhere else, and knowing which
code was created is worth more on event day than the line costs. Every other
write on that surface logs changed column *names* and never their values, which
is what keeps the rest of this sentence true of the editor. The redemption path
adds
`volunteerId`, `item` and `outcome`, and redacts the pass token, the review
handle and the `/staff/lookup` query, which may itself be a ticket code.

That sentence is older than the administrator surfaces, and what keeps it true
of them is `q`. The roster and the volunteer lookup both search on it, and it is
free text matched against `attendee_name`, `attendee_nickname`, `ticket_code`
and phone digits — so a single search can carry any of the three.

It used to travel in the query string, where `maskUrlSecrets` redacted it
alongside `password`, `token`, `code` and `t`, on the same reasoning
`/staff/lookup` applies to `req.body.query`: a credential does not stop being one
because it arrived under a different field name. Both logging paths went through
that — the `req` serialiser and the rate limiter — which mattered, because a
request about to be redirected to the sign-in form is logged too.

It travels in a request body now, for a reason the request log had nothing to do
with; see below. `q` stays in `maskUrlSecrets` as a backstop for a hand-typed
address or an old bookmark, and `req.body.q` was added beside `req.body.query`
so its cover moved with it.

`checkinNumber` is null on **both** sides of a volunteer redemption: neither the
volunteer being served nor the one serving them has one.

### The second exposure, which is narrower and deliberate

The volunteer quick lookup's record page **renders the verification code** — the last four digits, the shared secret above. Until that
screen existed, nothing in this application displayed them to anybody: the
attendee supplies them and `verifyAttendee` compares, and every other surface
shows `maskPhone`, which drops exactly these digits.

It exists for the case no other surface can resolve: an attendee at the door who
does not remember which number they registered with. A support volunteer reads
the code back and the person completes their own check-in.

What bounds it:

- **Who** — an authenticated administrator holding `attendees:read`, who reached
  the surface either over the tailnet or through Cloudflare Access with an
  address on its policy. Nobody else reaches the sign-in form, let alone the
  page. That bound moved when `/admin` went onto the public hostname, and it
  moved **inward**: the tailnet admitted every enrolled device, while the Access
  policy is an explicit list of people, revocable one at a time.
- **Where** — that one page, one attendee at a time. The search results carry
  no phone field at all, masked or otherwise, and that omission is asserted
  rather than assumed.
- **How** — inside a `details` element that is closed in the delivered HTML. It
  is not on screen until somebody asks for it, which is the control that matters
  against the realistic threat: a phone lying face-up on a table in a room full
  of people.
- **Never in a response an attendee can reach**, never in a log line, and
  **never in JSON**. The mark-present endpoint answers with three fields rather
  than the attendee row precisely because that row projects `attendee_phone`.

The full number is still shown in exactly one place, the attendees editor's
record form, because that is where a mistyped number gets corrected and a number
you cannot read is a number you cannot fix.

**This does not change what is stored.** The claim above still holds: the phone
lives in the `attendees` table and nowhere else, no session holds a digest of
it, and a Redis dump yields nothing that can be turned back into a number.

### The stores this project does not own

Everything else above is on servers this deployment controls and dies at
teardown. Two stores do not, and they are unalike enough to be worth naming
separately.

**Cloudflare holds the volunteers' email addresses** — on the Access policy, and
in a log of which of them reached `/admin` and when. That arrived with the move
to Access, and it is the one entry in the table above whose retention is somebody
else's decision. It is also the smaller problem: an address is not attendee data,
the volunteers are a handful of people who agreed to work the door, and the log
is an audit trail rather than a leak. It is inventoried because a store of
personal data outside this deployment should never be discovered later.

**The other is on the operators' own phones, and it holds attendee data whether
or not anybody intended it: the browser's own history.** That is the one this
surface was rebuilt around, and the rest of this section is about it.

It is the only place in this system where deleting an account does not delete
*attendee* data — the Access log outlives an account too, but what it holds is a
volunteer's own address. A history entry outlives the one-hour session, the Access policy entry
and the administrator row; and on a phone signed into Chrome or iCloud it is
synchronised off the device, into an account belonging to the volunteer rather
than to this project. Teardown cannot reach it. That is a poor place for a name
typed at a door, and the volunteer lookup — read by two or three roaming
volunteers on personal phones — is what made it worth acting on rather than
noting.

So the rule the administrator surface is built to:

> Everything that describes an attendee — filters and identifiers alike —
> travels in a request body. The surface navigates to exactly two URLs, and no
> page title names a person.

Three separate things wrote attendee data into that store, and all three are
closed:

- **The filters.** `/admin/attendees` and `/admin/lookup` are `POST` forms.
  `parseAttendeeFilters` reads `req.body` and there is no URL builder in
  `constants/attendee-filters.ts` any more, so a pager cannot grow one back —
  the pager is a submit button. A `GET` to either address arrives before any
  body parser has run and renders the cleared state, which is what makes an old
  bookmark inert rather than honoured.
- **The identifiers.** A record opens at `POST /admin/lookup/record` or
  `POST /admin/attendees/edit` with the ID in the body. The old
  `/admin/…/<uuid>` addresses still answer, and redirect.
- **The titles.** A history entry stores the page title as well as the URL, so
  the two record pages are titled `Consulta` and `Participante`. Leaving the
  attendee's name there would have kept it on the device after the ID left the
  path — the half of this that is easiest to miss.

What a volunteer's phone records after an evening of lookups is `/admin`,
`/admin/attendees` and `/admin/lookup`, and nothing else.

What it costs, so that nobody reverses it by accident:

- A filtered roster is no longer a URL to bookmark or send to a colleague, and
  neither is a record. The attendees editor argued for bookmarkable filters
  deliberately; this supersedes that.
- Reloading a result page, or reaching one with the back button, raises the
  browser's resubmission prompt. The volunteer's path — search, open a record,
  *Voltar* — does not hit it, because *Voltar* is a `GET`. The lookup's confirm
  button re-submits the record form rather than reloading for the same reason.

Two things this does **not** claim. The browser's back/forward cache can restore
a rendered result page from memory after a back navigation — it is per-tab, dies
with the tab and never syncs, but it is why "closed the tab" is a weaker
statement than "signed out". And the pages themselves are still read on a
personal device: this keeps attendee data out of the store that persists, not
off the screen.

### Why `redemptions` and `raffle_draws` are in neither purge script

Both purge scripts redact `attendees` and nothing else, and that is correct
rather than an oversight. A redemption row holds two UUIDs, an item, an outcome
and a timestamp — no name, no phone, no ticket code — so there is nothing in it
to redact. It is destroyed with the `data` volume at teardown along with
everything else.

`raffle_draws` is the same shape and the same answer: two UUIDs, a check-in
number and timestamps. The number is the one field worth a second look, and it
is a display value rather than an identifier — it is called aloud across a room
by design. Once `attendees` is redacted it maps to nobody.

Note that this makes both **useless on their own**: without the attendee rows
they point at, they are lists of anonymous UUIDs. That is the intended end
state.

The entry link is the one thing that used to slip through. `GET /checkin?t=…`
carries `ticket_link_token` in the URL, and every path that logs a URL passes it
through `maskUrlSecrets`, so the token reaches neither stdout nor anything
downstream of it. Before check-in opens, the landing page also removes `t` and
`k` from the address bar on load, so they do not reach browser history.

That is stated as a rule rather than a list on purpose. It read "logged twice —
by the `req` serializer and by the rate limiter" until the two error handlers and
the cross-origin rejection were found logging `req.originalUrl` raw, which is how
a `?q=` typed by hand into `/admin/lookup` reached the log the moment it tripped
`webLimiter`. A count of call sites is a claim that goes stale silently. That function also redacts `password`, `token`, `code` and `preview` (the
landing bypass token), so a form that
reaches the network as a `GET` cannot write a credential into the log. The
poster token (`?k=`) is left visible on purpose: it is printed on a wall, and
seeing it is how arrivals get reconciled.

## Teardown — the one procedure that matters

Run in this order. The export has to happen before the volume is destroyed, and
nobody gets a second attempt.

**0. Forget who answered the questionnaire.** The privacy notice says that record is deleted before
the final report, and this is what makes it true. As the migrator role:

```bash
# Compose reads .env for itself; it does not export it to this shell.
set -a; . ./.env; set +a
echo "migrator=$POSTGRES_MIGRATOR_USER readonly=$POSTGRES_READONLY_USER db=$POSTGRES_DB event=$EVENT_ID"
#    none empty, and event is the real id, not the .env.example placeholder
docker compose exec -T db psql \
  -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/purge-attendees.sql   # expect completions_remaining = 0, survey_override = closed
```

It redacts names and phones as well, which costs the results export nothing: that file carries
neither, and the ticket code it keeps is untouched.

**1. Export what you are keeping**, as the read-only role:

```bash
docker compose exec -T db psql \
  -U "$POSTGRES_READONLY_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/export-results.sql > checkin-results.csv

docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
  --audience participant > survey-participant.csv
docker compose run --rm -T migrate node scripts/survey/export-csv.ts \
  --audience volunteer > survey-volunteer.csv
```

**2. Check what you are about to keep**, before anything is destroyed:

```bash
head -1 checkin-results.csv | grep -c 'phone\|name'    # expect 0
wc -l checkin-results.csv                              # roster count + 1
head -1 survey-*.csv | grep -ci 'name\|phone\|ticket' # expect 0
wc -l survey-*.csv                                     # each: /admin/survey's count + 1
```

**3. Destroy the stack and its data:**

```bash
docker compose down -v
docker volume ls | grep pelicanpass          # expect nothing
```

`-v` is what removes the `data` volume. Without it the volume survives the
containers and the phone numbers survive with it, on a host nobody is watching
any more.

**4. Delete the dumps.** Every `pg_dump` taken during the event, wherever it was
copied to — the host, a laptop, a chat message. This is the step that gets
skipped, and it is the only one that can undo the other three.

**Telemetry is captured before step 3, or not at all.** The rotating log file
and `app_events` both die with the volumes, and both hold personal data — the
file holds addresses and actor ids that no SQL purge can reach, and the table
holds the same plus scrubbed context. `deployment.md`'s teardown has the two
commands. Whatever is taken joins the dumps above on the same deletion
schedule; running `purge-attendees.sql` first nulls the table's `ip`,
`actor_id` and `context` while leaving the fingerprints and routes that make an
error history worth keeping.

### If a full dump has to be kept

Purge first, then dump. As the migrator role:

```bash
set -a; . ./.env; set +a
echo "migrator=$POSTGRES_MIGRATOR_USER readonly=$POSTGRES_READONLY_USER db=$POSTGRES_DB event=$EVENT_ID"
#    none empty, and event is the real id, not the .env.example placeholder
docker compose exec -T db psql \
  -U "$POSTGRES_MIGRATOR_USER" -d "$POSTGRES_DB" \
  -v ON_ERROR_STOP=1 -v event_id="$EVENT_ID" \
  < scripts/db/purge-phone.sql          # expect phones_remaining = 0
```

Names survive that one. `scripts/db/purge-attendees.sql` takes those too, and
rotates `ticket_link_token` so printed links stop resolving. Then dump.

### Sessions

Nothing to do. Both session types carry a Redis TTL and expire on their own; the
longest is 24 hours, which is the same window as the host itself. Whichever
expires first, there is no session data left to purge.

## How the purge scripts are meant to be run

**Plain SQL, run by hand. Neither is a migration**, and neither should become
one. `node-pg-migrate up` runs every pending migration, so a purge in
`migrations/` would fire the next time anyone migrated for an unrelated schema
change — including during the event. Data destruction has to be something a
person decides to do.

Two files rather than one because they answer different questions: phone numbers
alone, for a dump that has to be kept, versus the full redaction. Whoever runs
the narrow one must not destroy names as a side effect.

Both scope every statement on `event_id` and end with a count, so a run reports
its own result rather than leaving the operator to check. A non-zero remainder
means rows were missed, most likely a mistyped `EVENT_ID`.

Neither is reversible, and after teardown there is no backup to restore from.

```bash
docker compose exec -T db sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t attendees -t redemptions -t raffle_draws -t app_events -t whatsapp_runs -t whatsapp_sends -t whatsapp_door_sends -t whatsapp_door_state -t survey_responses -t survey_completions -t survey_state -t pass_welcome_state -t volunteer_permission_changes' \
  > attendees-backup.sql
```

`redemptions`, `raffle_draws`, `app_events`, the four WhatsApp tables, the
three survey tables and `volunteer_permission_changes` are named explicitly. A backup taken before a purge that
omitted them would lose the redemption audit trail, the record of the raffle,
the error history, the record of who was messaged, the questionnaire's
answers and the volunteer permission audit while appearing complete. Any
table added later has to be added here too; the flag list is not a wildcard.

`app_events` is the one of the three that a purge **does** now touch —
`purge-attendees.sql` nulls its `ip`, `actor_id` and `context` alongside the
attendee redaction. So the ordering advice above applies to it in the same way:
dump before the purge and the dump carries addresses, dump after and it does
not. The rest of the row survives either way, which is the point — what broke
and how often is worth keeping, and identifies nobody.

**The log volume is not in this dump and cannot be.** It is a file, not a table.
If the `warn`+ NDJSON is being kept for post-event analysis, copy it out with
`docker compose cp app:/var/log/pelicanpass ./logs-archive` before `down -v`, and
note that it holds IPs and actor ids that no SQL purge reaches — it is subject
to the same deletion decision as the dumps, on the same schedule.

### Who can run them

Only `pelicanpass_migrator` or the superuser. `005_app-role-grants` grants the
application role `UPDATE` on the four check-in columns and nothing else, so the
role the app connects as is refused:

```
ERROR:  permission denied for table attendees
```

That is not an obstacle to work around — it is what makes a purge a deliberate,
privileged act rather than something an application bug could cause.

## Deletion on request

There is no self-service deletion path, and for a single-event roster of ~700
people that is a reasonable position: the data has one purpose, a short life and
a scheduled end. A request for early erasure is handled by hand against the one
row:

```sql
UPDATE attendees
SET attendee_phone = '',
    attendee_name = 'REDACTED',
    ticket_link_token = translate(
      encode(gen_random_bytes(16), 'base64'), '+/=', '-_'
    ),
    updated_at = now()
WHERE ticket_code = '<code>'
  AND event_id = '<event id>';
```

Run as `pelicanpass_migrator`. Doing this before the event means that attendee can
no longer check in — their verification code is gone — so confirm that is what
they are asking for.

**After teardown there is no row to erase.** A request arriving then is answered
by the fact that the database no longer exists; the only remaining record is the
results export, and honouring the request there means deleting that person's
line from the CSV. If the export was produced without `ticket_code`, there is no
line to find and nothing to delete — one more reason to decide that question
deliberately.

**The questionnaire has no answer to delete for a person, before teardown or after.** Nothing
links an answer to whoever gave it, so a request to erase "my answers" cannot be carried out, and
that is the anonymity doing its job. Say so to whoever asks. Before teardown, deleting their row in
`survey_completions` would erase only the fact that they answered, and would let them answer again.
