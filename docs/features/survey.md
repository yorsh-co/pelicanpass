# Experience Questionnaire

How the questionnaire on the attendee pass works: who is offered it and when, how its questions are
written, how one anonymous answer per attendee is enforced, what organisers control, and what
survives the event.

Written for whoever edits the questions, runs the event or takes the answers away afterwards, and
was not here while it was built.

Companion documents:

- [`deployment.md`](../operations/deployment.md): [on the day](../operations/deployment.md#on-the-day-at-the-venue), the
  [staging rehearsal](../operations/deployment.md#rehearsal--the-questionnaire) and
  [teardown](../operations/deployment.md#teardown). This document explains; those sections are the commands.
- [`data-retention.md`](../security/data-retention.md): what each table holds and when it goes, and
  [why the export is anonymous](../security/data-retention.md#the-survey-export-is-anonymous)
- [`copy-management.md`](../development/copy-management.md#edit-the-questionnaire): the copy reviewer's short
  version of the editing rules
- `src/web/content/pt-BR/privacy-notice.md`: what attendees are promised

The design reasoning behind every decision here, including the routes considered and rejected, is
kept in the retired design record in the private archive,
`git show b157abd:docs/participant-survey-plan.md`; the build log beside it is
`git show b157abd:docs/participant-survey-checklist.md`. This document states what runs; that one
says why.

---

## What this does

**For an attendee.** While the questionnaire is open to their audience and they have not answered,
a chip reading *Responder questionário* sits on its own line on the front of their pass. It opens
the form in a dialog over the pass. Sending it stores their answers once, anonymously, and the chip
goes.

**For an organiser.** `/admin/survey` shows whether the questionnaire is open and why, each
audience's switch and answer count, a control to force it open or closed, and a CSV download per
audience.

**At teardown.** `scripts/survey/export-csv.ts` writes each audience's answers to a CSV, as the
read-only role. That file, and the results export beside it, are what outlive the host.

```
 pass chip ──▶ dialog ──▶ POST /api/v1/survey ──▶ survey_completions  (who answered)
                                               └▶ survey_responses    (what was answered)
                                                          │
 /admin/survey ◀── survey_export (view) ◀─────────────────┤
 export-csv.ts ◀──────────────────────────────────────────┘
```

Two audiences, **participants** and **volunteers**, each with its own questions, its own switch and
its own CSV. One schedule and one override govern both.

### Where it is stored

Created by migration `020`; the override's scope, `survey:write`, by `021`.

| Object               | Holds                                                   | Readable by                                  | Goes                                                           |
| -------------------- | ------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------- |
| `survey_completions` | `(event_id, attendee_id)` — that someone answered       | The application (its own two columns)        | Deleted by `purge-attendees.sql`; otherwise with the `data` volume |
| `survey_responses`   | Answers, audience, `survey_version`, a random id, a date | Nobody but the migrator and superuser        | Survives in the CSVs; the table dies with the volume          |
| `survey_state`       | The override and the admin id that set it              | The application                              | With the `data` volume                                         |
| `survey_export`      | A view over `survey_responses`, named columns only      | The application and the read-only role       | —                                                              |

---

## Turning it on

Four variables, documented in `.env.example`:

| Variable                     | Default | Meaning                                                                                 |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------- |
| `SURVEY_PARTICIPANT_ENABLED` | `false` | Participants are offered the questionnaire                                              |
| `SURVEY_VOLUNTEER_ENABLED`   | `false` | Volunteers are offered theirs. Needs `survey-volunteer.md`                               |
| `SURVEY_OPENS_AT`            | —       | When it opens. ISO-8601 **with an offset**. Required when either switch is on           |
| `SURVEY_CLOSES_AT`           | unset   | When it closes. Optional: unset, it stays open until an administrator closes it         |

Changes take effect on `docker compose up -d --force-recreate app`; a restart re-reads nothing.

**Whether an audience may answer** is decided in one place, `isSurveyOpenFor` in
`src/modules/survey/survey.window.ts`, in this order:

1. Its switch is on. Off means no chip, no dialog, and a refused submit, whatever else is set.
2. It has a questions file.
3. The window is open: an override (`open` or `closed`) set on `/admin/survey` wins; otherwise open
   from `SURVEY_OPENS_AT` until `SURVEY_CLOSES_AT`.

The override applies to both audiences at once and can never open an audience whose switch is off.
To open by hand only, set `SURVEY_OPENS_AT` far in the future and use the override.

### What refuses to boot

A misconfiguration fails at startup rather than at the door, and the log names the setting:

- a switch on without `SURVEY_OPENS_AT`;
- a time without an explicit offset;
- `SURVEY_CLOSES_AT` not after `SURVEY_OPENS_AT`;
- `SURVEY_VOLUNTEER_ENABLED=true` with no `src/web/content/pt-BR/survey-volunteer.md`;
- `SURVEY_CLOSES_AT` further than `ATTENDEE_SESSION_TTL` after the earliest check-in opening among
  the switched-on audiences (volunteers' door when their switch is on);
- any questions file that breaks the grammar below.

The session rule exists because the pass never refreshes a session: an attendee who checks in as
their door opens and then only looks at their pass must still hold a session when the questionnaire
closes, or the form they were promised answers `401`. It is measured only when the landing curtain
is on, since that is what sets the doors.

---

## The questions files

The questions are Markdown in the repository, not copy in the catalogs, so they can be edited
without touching code:

- `src/web/content/pt-BR/survey-participant.md`: **required**, whether or not participants are
  switched on.
- `src/web/content/pt-BR/survey-volunteer.md`: optional. It may be committed as a draft with its
  switch off; `npm run survey:check` validates it either way.

Each file is a complete questionnaire of its own: title, intro, questions and versions. Ids need
only be unique within a file.

An edit is a commit and a redeploy. The files are parsed once at boot by
`src/modules/survey/survey.definition.ts`.

### Grammar

```md
<!--
  Editing notes live in HTML comments, which are ignored.
-->

# Questionário de experiência

Optional intro: any paragraphs before the first question.

## Como você avalia {eventName} de modo geral?

- id: overall_rating
- type: rating
- required: yes

Optional hint: one paragraph, shown under the question.

## O que podemos melhorar?

- id: improvements
- type: text
- required: no
- max-length: 500
```

- **Exactly one `#` heading**, the title, before any question. Paragraphs between it and the first
  `##` are the intro.
- **Each `##` heading is a question**, and its text is the label.
- **A bulleted list must follow it**, with plain `key: value` items:
  - `id` matches `^[a-z][a-z0-9_]{0,39}$`, and is unique in the file. It is the CSV column header and
    the key the answer is stored under, so it never changes once answers exist.
    Ids are English snake_case (`overall_rating`); the copy (headings, hints, title, intro) is pt-BR.
  - `type` is `rating` (1 to 10), `yes-no` or `text`. A rating is answered on a slider, dragged or
    tapped, or by typing the number into the box beside it.
  - `required` is `yes` or `no`.
  - `max-length` goes only on `text`, from 1 to 1000, and defaults to 500.
- **At most one paragraph after the list**: the hint.
- **At least one question.**
- **A file's text questions may allow 2000 characters in all.** The API accepts at most 10 KB of
  JSON, and 2000 characters is at most 8 KB of UTF-8; past that a long answer would be refused with
  a `413` the form can only report as a failure.
- **Placeholders such as `{eventName}`** are filled from the copy defaults. See
  [`copy-management.md`](../development/copy-management.md).
- **Inline Markdown works** in the title, intro, labels and hints — `**bold**`, links. Images,
  raw HTML and links whose address is not relative, `http`, `https` or `mailto` (`javascript:`,
  `data:`, `vbscript:`) do not: the app refuses to boot with them. The text is also rendered
  with raw HTML escaped and such links dropped, as a second layer.

**Anything else is an error**: a numbered or nested list, a table, code, a second hint, an unknown
or repeated property, a missing `id`, `type` or `required`. Every error names the file and, where
there is one, the question:

```text
survey: src/web/content/pt-BR/survey-participant.md: "## Como você avalia a programação?": "max-length" applies only to text questions
```

`npm run survey:check`, part of `npm run check`, runs exactly the checks the boot runs, over every
file, and reports every problem in one pass.

### Versions

Each audience has two, both derived — nobody bumps them. Each is the first 12 hex characters of a
SHA-256 over that audience's pt-BR questions, in order:

- **`structureVersion`** covers ids, types, required flags and max-lengths. The form carries it.
  A submit made under a different one is refused `SURVEY_STALE`, and the form reloads to show the
  current questions.
- **`version`** also covers labels and hints. It is stored on every answer as `survey_version`, so
  the CSV says which wording each answer was given to.

### Editing rules

| Change                         | Effect on forms already open                                               |
| ------------------------------ | -------------------------------------------------------------------------- |
| Wording of a label, hint, title | None. They still submit; new answers carry the new `survey_version`        |
| Add a question                 | They reload on submit and show it                                          |
| Remove a question              | They reload. Answers it already had move to `other_answers` in the CSV    |
| **Change an `id` or a `type`** | **Don't, once it has opened.** Earlier answers stay under the old key or shape, and nothing can check this, because the check cannot see the database |

Each file stands alone: editing one audience's questions never disturbs the other's open forms.

### Translations

A translation, `src/web/content/<locale>/survey-<audience>.md`, is optional; a locale without one is
served pt-BR's, as the privacy notice is. It may change only the text: the same ids, in the same
order, with the same types, required flags and max-lengths. A translated volunteer file with no
pt-BR one is an error, because pt-BR alone decides whether volunteers have a questionnaire. Both
versions always come from pt-BR, so translating changes neither.

---

## Who can answer, and how often

**Only an attendee with a live session can see the form or send it, and each attendee answers
once.** `POST /api/v1/survey` accepts `{ structureVersion, answers }` and applies these in order:

| Check                                                       | Refusal                     | What the pass does                              |
| ----------------------------------------------------------- | --------------------------- | ----------------------------------------------- |
| An attendee session naming an attendee                     | `401 UNAUTHORIZED`          | Sends them to check in again                    |
| The window is open                                          | `403 SURVEY_CLOSED`         | Closes the dialog, hides the chip, says so      |
| The attendee is checked in and not archived, **read from Postgres** | `404 NOT_FOUND`     | Says the send failed, in the dialog             |
| Their audience is switched on and has questions             | `403 FORBIDDEN`             | Closes the dialog, hides the chip, says so      |
| The form's `structureVersion` is current                    | `409 SURVEY_STALE`          | Reloads, then says the questions changed        |
| The answers fit the questions                               | `400 VALIDATION_ERROR`      | Says the send failed, in the dialog             |
| They have not already answered                              | `409 SURVEY_ANSWERED`       | Closes the dialog, hides the chip, says so      |

On success it is `201`: the dialog closes, a toast thanks them, and the welcome line turns to the
thanks.

Whatever the answer, the submit's spinner holds for at least `MIN_PROCESSING_MS`
(`src/web/client/modules/ui/pacing.ts`) from the tap, so a fast send does not close the dialog the
instant it is tapped.

The dialog closes rather than showing a thanks of its own, and a send worth retrying is reported
inside it rather than in a toast, because a modal dialog sits in the top layer, above the toast.

- **The role comes from the attendee row**, never the session, and the answers are checked against
  that role's questions and stored under that role, in the same transaction. An administrator who
  archives someone or changes their role after check-in is obeyed on the next submit.
- **Once per attendee, not per session.** The completion's primary key is `(event_id, attendee_id)`
  and is written first: a second phone, a second check-in or two submits in flight at once all end
  with exactly one answer stored.
- **Answers are validated strictly.** A rating is an integer from 1 to 10, a yes/no is a boolean,
  text is trimmed and refused — not cut — past its `max-length`; unknown ids are refused, a blank
  answer is left out, and a required one left blank is refused. Refusals name no question and no
  value.
- **The submit is exempt from the per-address rate limit**, as the pass is: an announcement sends
  the whole room at once from the venue's one address. It is still limited per session, and the
  schema takes one answer per attendee.

### When the chip appears

The pass is rendered with the chip shown or hidden. After that, the chip follows the `survey` field
of the pass poll, `{ open, completed }`, which runs only while the pass is turned to its back and
fetches once more as it turns to the front. **There is no poll of its own**, so an attendee sees the
chip on their next reload or their next turn of the pass. An announcement — "open the app and
reload" — covers the rest.

The poll only shows or hides the chip. It never closes a dialog someone is typing in; if the window
shuts meanwhile, their send is refused `SURVEY_CLOSED`, and that closes it.

### The welcome line

While the welcome schedule — `PASS_WELCOME_SCHEDULE`, or the one saved at `/admin/pass` — is in its
`survey` phase, the line under the attendee's name points down at the chip. The server settles that phase per attendee (`welcomePhaseFor` in
`src/config/pass-welcome.ts`): once they have answered it reads `thanks`, and while the
questionnaire is not open to them it reads `default`. A successful send switches it to `thanks` at
once, without waiting for a poll. Other scheduled phases, a custom line written at `/admin/pass`
included, are shown as scheduled.

---

## Anonymity

"One answer per attendee" means knowing who answered; "anonymous" means nobody can tell which answer
was theirs. They are reconciled by storing the two facts apart, with nothing that joins them:

- **Two tables.** `survey_completions` knows who answered and nothing else. `survey_responses`
  holds the answers and the audience, and no attendee column.
- **No order and no time.** `response_id` is a random uuid, not a serial; `submitted_on` is a date,
  not a timestamp. An order or a precise time would join to the request log, to `app_events` or to
  a check-in time. Exports order by `response_id`.
- **No system columns.** The two rows are written in one transaction, so they share an `xmin`, and
  `ctid` order is insertion order — either pairs them for anyone with table-level `SELECT`. The
  application role has no `SELECT` on `survey_responses` at all, and migration `020` revokes the
  read-only role's default `SELECT` on both tables. Both read answers only through `survey_export`,
  which projects named columns.
- **Nothing logs the answers.** The request log never records a body, and `answers` is on the
  redaction list as a backstop.

What this does **not** protect, stated so that nobody promises more:

- **Small numbers.** Three answers on a day are three people.
- **Free text.** An answer that names its author is signed.
- **Volunteers.** They are few, known by name, and describe shifts only some of them worked. Their
  CSV is anonymous in the schema's sense and far easier to re-identify by reading. The volunteer
  form and `/admin/survey` both say so.
- **A wording change mid-window** splits respondents into before and after, and the request log
  records who submitted when. The fewer on one side, the more that says.
- **The migrator and the superuser** can still read `xmin` and `ctid` until the purge deletes the
  completions or the host is torn down.

---

## The administrator surface

`/admin/survey` (*Questionário* in the navigation):

- **The page and the downloads need `export:read`.** Whoever may take the answers away may see the
  state and counts.
- **The override needs `survey:write`** as well: the control is drawn only for it, and its API,
  `POST /api/v1/admin/survey/override`, enforces it again. Whoever runs the questionnaire needs both
  scopes, granted with `scripts/admin/set-admin-scopes.ts`.

The page shows the state and why (switched off, forced by an administrator, or following the
schedule), the schedule in the event's time zone, each audience's switch and answer count, a
download per audience, the volunteer re-identification note, and the *Automático* / *Forçar aberto* /
*Forçar fechado* control. The volunteer download appears when a volunteer file exists or volunteer
answers do, so answers collected before a file was removed can still be taken.

**The live panel.** `/admin/metrics` carries a _Feedback_ card for an administrator who holds
`export:read` as well as `metrics:read`: total answers, each audience's answers against its
check-ins, whether the questionnaire is open and why, and a link here. It shows **totals only**, with
no rate and no sparkline, and no telemetry counter records submissions. A per-minute series
would put back the timing that `submitted_on` being a date leaves out. A count refreshed every five
seconds can still be watched as it moves, which is the [small-numbers](#anonymity) limit again.

**The override** is stored in `survey_state`, so it survives a container recreate. It is read at most
once every five seconds per instance: the one that saved it shows the change at once, others within
five seconds. `survey_state.updated_by` is the durable record of who set it — not an `app_events`
row, which by design stores no `domain` events.

---

## Getting answers off the host

Two paths, one file per audience, identical bytes: the **download** on `/admin/survey`, during and
just after the event, and **`scripts/survey/export-csv.ts --audience participant|volunteer`**, the
teardown artifact, run in the app container as the read-only role. They share one query and one
builder, so they cannot differ in rows, columns or safety.

The file, `survey-<audience>.csv`:

- columns `response_id`, `submitted_on`, `survey_version`, one per question id in the file's order,
  then `other_answers` — JSON of any answer the current questions no longer define, so removing a
  question loses nothing, and an audience whose file is gone has every answer there;
- a rating as its number, a yes/no as `yes` or `no`, text verbatim, an unanswered question empty;
- **formula-safe**: a cell starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`, so an
  answer like `=HYPERLINK(…)` stays text in a spreadsheet;
- UTF-8 with a byte-order mark, so a spreadsheet opened by double-click keeps the accents; RFC 4180
  quoting and CRLF line endings.

**Teardown runs `scripts/db/purge-attendees.sql` first.** It deletes the completions and, in the same
transaction, forces the questionnaire closed with `updated_by` empty — with the one-response guard
gone, an open questionnaire would take a second answer from anyone still signed in. The privacy
notice promises the record of who answered is deleted before the final report, and running the purge
before the exports is what makes that true. The commands are in
[`deployment.md` § Teardown](../operations/deployment.md#teardown).

---

## Operating notes

**Before the event**

- **Replace the placeholder questions** with the organisers' own, and remove the `PLACEHOLDER` line
  from each file's header. Nothing stops a placeholder reaching an event but this step.
- **Set the switches and times**, and confirm `ATTENDEE_SESSION_TTL` covers the span above. Boot
  refuses a configuration that breaks it.
- **Grant `export:read` and `survey:write`** to whoever runs the questionnaire.
- **Run the staging rehearsal**, [`deployment.md` § Rehearsal — the questionnaire](../operations/deployment.md#rehearsal--the-questionnaire),
  then reset staging's survey tables — including `survey_state`, or a closed override carries into
  the event.

**During the event**

- **Announce it.** The chip appears on a reload or a turn of the pass, not the instant it opens.
- **Wording can be fixed at any time.** Adding or removing a question reloads open forms, which
  loses what someone had typed; do it only if it matters.
- **Force it open or closed** from `/admin/survey`; set it back to *Automático* to hand back to the
  schedule.

**After the event**

- Purge, export and check the files, then tear down, in that order — see
  [`deployment.md` § Teardown](../operations/deployment.md#teardown).
- **A request to delete "my answers" cannot be carried out**: nothing links an answer to a person.
  That is the anonymity working; say so. Deleting their completion row would only let them answer
  again.

**Accepted limits**

- **No live push.** The chip waits for a reload or a turn of the pass; a dedicated poll would put a
  request per attendee on a face that otherwise makes none.
- **A role changed mid-form** makes the send stale, and the reload shows the other audience's form
  (or none).
- **A session minted for the rehearsal is a real session** for its whole TTL. The helpers that do it
  are for staging only.

---

## Privacy

What holds across the whole feature:

- **No answer text reaches a log line, an alert or an `app_events` row.**
- **The CSVs carry no attendee, no time and no order** — anonymous, unlike the pseudonymous results
  export.
- **The record of who answered is deleted before the final report**, by the purge that teardown
  runs first.
- **The form says what it promises.** Each audience's anonymity line is worded to what the schema
  delivers for it; the volunteer line warns rather than repeating the participant promise.

[`data-retention.md`](../security/data-retention.md) is the inventory of record.

---

## Code map

| Where                                                   | What                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `migrations/020_survey.ts`                              | The three tables, the view, the grants and the read-only revoke        |
| `migrations/021_admin-scopes-survey.ts`                 | The `survey:write` scope                                               |
| `src/modules/survey/survey.definition.ts`               | Parses the questions files at boot; `surveyFor(role, locale)`          |
| `src/modules/survey/survey.window.ts`                   | Switches, schedule and override; the boot checks; `isSurveyOpenFor`    |
| `src/modules/survey/survey.service.ts`                  | The submit and its checks; `validateAnswers`                           |
| `src/modules/survey/survey.repository.ts`               | The submit transaction, the override, counts and export rows           |
| `src/modules/survey/survey.csv.ts`                      | `buildSurveyCsv`, shared by both exports                               |
| `src/modules/survey/survey.admin.ts` and `.admin.*`     | `/admin/survey`'s overview, CSV and override API                       |
| `src/constants/survey-coverage.ts`                      | The `/admin/metrics` card's answers-against-check-ins rows             |
| `src/modules/survey/survey.controller.ts`, `.routes.ts` | `POST /api/v1/survey`                                                  |
| `src/types/survey.ts`                                   | Definitions, answers, state                                            |
| `src/web/views/components/survey-dialog.ejs`            | The form, rendered from the attendee's questions                       |
| `src/web/views/components/pass.ejs`                     | The chip                                                               |
| `src/web/client/pages/attendee/pass/ui/survey.ts`  | The chip, the dialog, the counters and the send                        |
| `src/web/views/pages/admin/survey/`, `src/web/client/pages/admin/survey/` | The administrator page and its override control      |
| `src/i18n/messages/pt-BR/survey.json`, `admin-survey.json` | Interface copy — never question text                                 |
| `src/web/content/pt-BR/survey-*.md`                     | The questions                                                          |
| `scripts/survey/check.ts`                               | `npm run survey:check`                                                 |
| `scripts/survey/export-csv.ts`                          | The teardown export                                                    |
| `scripts/db/purge-attendees.sql`                        | Deletes completions and closes the questionnaire                       |
