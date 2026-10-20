# WhatsApp Integration

How this application sends entry links over WhatsApp, how it learns whether they arrived, and what
has to exist in the Meta dashboard and in `.env` before any of it works.

Written to be followed top to bottom by someone setting this up for an event who was not here while
it was built.

Companion documents:

- [`whatsapp-message-api-errors.md`](./whatsapp-message-api-errors.md) — Meta's error-code reference
- [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md) — the edge objects the callback depends on
- [`data-retention.md`](../security/data-retention.md) — what personal data this holds and when it goes

The design reasoning behind every decision here is kept in the retired build record in the private
archive, `git show e3cdaee:docs/whatsapp-sender-plan.md`. This document states what runs; that one
says why.

---

## What this does

Two directions, configured and switched independently.

**Outbound.** An administrator opens *Mensagens* (`/admin/whatsapp`, scope `whatsapp:send`),
chooses a template and an audience, previews the count, and starts a run. The application then sends
one approved template message per attendee, paced at one per second, recording every attempt. Each
message carries the attendee's first name, their ticket code, and — inside Meta's approved button
URL — the token that opens their entry link. The two feedback templates (`pax_survey_v1`,
`vol_survey_v1`) reach only attendees whose check-in is complete, as `checkedInOnly` in
`WHATSAPP_TEMPLATES` sets.

**Inbound.** Meta posts delivery receipts back to a callback URL. The application verifies each
batch, advances what it knows about each message (`sent` → `delivered` → `read`, or `undelivered`),
and reports the totals on the same screen.

Two tables hold it, both created by migration `018` and both destroyed with the `data` volume:
`whatsapp_runs` (one row per run) and `whatsapp_sends` (one row per recipient per run).

```
Mensagens screen ──▶ whatsapp_runs / whatsapp_sends ──▶ runner ──▶ Graph API ──▶ attendee
                                  ▲                                                  │
                                  └──── webhook callback ◀──── delivery receipts ◀───┘
```

### The states worth knowing

Each `whatsapp_sends` row carries two independent statuses, and the separation is deliberate: one
records what *we* did, the other what *Meta* reported.

| Column            | Values                                                                        | Means                                         |
| ----------------- | ----------------------------------------------------------------------------- | --------------------------------------------- |
| `status`          | `pending`, `sending`, `sent`, `failed`, `skipped`, `deferred`, `interrupted`   | How far our own attempt got                   |
| `delivery_status` | `sent`, `delivered`, `read`, `undelivered`                                     | What Meta reported afterwards, or nothing yet |

`delivery_status` only ever advances. A receipt that arrives late and out of order cannot move a
message backwards — a `failed` arriving after a `read` is ignored, because the message demonstrably
arrived.

A run is `running`, `paused`, `done` or `failed`, and only one run may be active at a time.

---

## Before you start

Four things must exist in Meta's account, and one of them has a lead time measured in days.

1. A WhatsApp Business phone number, with its **messaging-limit tier** known.
2. A System User access token.
3. An approved message template.
4. An app secret, for the receipts.

**Template approval is on the critical path.** Meta reviews submissions, and a rejection or a
re-categorisation costs another round trip. Submit the template before anything else here, and read
[The template](#4-the-template) first so that what you submit matches what the code sends.

**The messaging-limit tier caps a single run.** It was read as `TIER_2000` on 2026-09-10, which is
why a roster of roughly 700 fits in one 24-hour window. It is a portfolio-level number shared across
every phone number in the business portfolio, nothing in this application can see it, and it can
move. **Re-read it per event** in WhatsApp Manager → Account tools → Phone numbers.

---

## Meta dashboard setup

In dependency order. Each step produces a value; where it goes is in
[Environment variables](#environment-variables).

### 1. The phone number id

**WhatsApp Manager → Account tools → Phone numbers.**

Record the **`PHONE_NUMBER_ID`** — Meta's internal identifier for the business number, a long
numeric string. **Not the phone number itself.** Record the WABA id while you are there; nothing
reads it, but it is what support will ask for.

### 2. The access token

**Business Settings → Users → System users → Generate token.**

It must be a **System User token**. A user token or a page token expires, and the expiry ends a run
mid-flight with error `190` — at whatever moment Meta chooses rather than a convenient one.

This is a long-lived secret. Back it up wherever `PASS_SECRET` is backed up. Unlike that one, it
authorises a third party's API on the church's own WhatsApp number, so losing it is a different kind
of problem from losing a signing key.

### 3. The app secret

**Meta App → Settings → Basic → App Secret.**

**This is not the access token.** They are both "the WhatsApp secret" in conversation and they are
different credentials from different screens. The access token authorises what we send *out*; the
app secret is the key Meta signs everything it sends *in*. Using one where the other belongs fails
as a `403` on every single receipt, with nothing else visibly wrong — the sends keep working and the
delivery counts simply never move.

Confirm by eye that the two values differ before you save either.

### 4. The template

**WhatsApp Manager → Account tools → Message templates → Create template.**

| Property     | Value                            | Why it matters                                                     |
| ------------ | -------------------------------- | ------------------------------------------------------------------ |
| Name         | `pax_wk_v1`                      | Meta identifies a template by name and language, nothing else       |
| Language     | `pt_BR`                          | Underscore, not a hyphen — `pt-BR` is a `132001` on every message   |
| Category     | **`utility`**                    | `marketing` picks up a per-user frequency cap that utility escapes  |
| Body `{{1}}` | The attendee's first name        | Positional; the order is the contract                              |
| Body `{{2}}` | The ticket code                  | The fallback an attendee types when the link will not open          |
| Button       | URL, `https://<host>/checkin?t={{1}}` | The variable must be **at the end**                            |

**Three ways to get this wrong, each of which fails every message in the run rather than one:**

- **A different number of body variables** is a `132000`.
- **A hyphenated language code** is a `132001`.
- **A button URL that hardcodes the whole link**, or takes the link as a body variable, breaks a
  privacy guarantee rather than a send. The scheme, host and path live inside Meta's approved
  template; our payload supplies only the bare token. That is what keeps a full, working entry link
  out of our own request bodies and logs.

If what Meta approves differs from the table above, **change the registry rather than the code
around it** — `WHATSAPP_TEMPLATES` in `src/constants/whatsapp-templates.ts` is one object literal,
and the `body` array must list variables in the approved `{{n}}` order.

**Volunteer templates may carry three more variables**, each always non-empty because Meta refuses an
empty parameter:

| Variable      | Sent as                                                  | When unset  |
| ------------- | -------------------------------------------------------- | ----------- |
| `team`        | The team as stored                                       | `a definir` |
| `checkinTime` | The arrival time as the event writes it: `8h`, `8h30`    | `a definir` |
| `lunchOption` | `🍴 Almoço: 11h30`, with the prefix                      | `-`         |

Lunch reads as a bare `-` rather than `a definir` because not every volunteer has lunch, and the
slot must not suggest otherwise. Approve the template with the slot standing on its own line, with no
label of its own. A template that uses any of the three must be offered to volunteers only; a test
over the registry enforces it.

**No copy-code button.** Meta allows `copy_code` buttons on marketing templates only, and this
template has to stay `utility`. The ticket code is in the body as `{{2}}`, where an attendee can
long-press to copy it.

### 5. The webhook callback

**Meta App → WhatsApp → Configuration → Callback URL.**

| Field         | Value                                              |
| ------------- | -------------------------------------------------- |
| Callback URL  | `https://<host>/api/v1/whatsapp/webhook/<path-secret>` |
| Verify token  | `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, exactly as in `.env` |
| Subscribed field | `messages`                                      |

Press **Verify and Save**. Meta sends a `GET` carrying a challenge, and the application echoes it
back verbatim. If the values match and the edge lets the request through, the subscription saves.
This is also the cheapest test of the Cloudflare ASN rule: **if the ASN clause is wrong, the
subscription will not save**, and Security Events will name the rule that refused it.

**Then subscribe the app to the WABA.** Saving the callback is not enough on its own: real status
events only flow once the app is subscribed to the WhatsApp Business Account that owns the number.

```sh
curl -s -X POST "https://graph.facebook.com/$WHATSAPP_GRAPH_VERSION/$WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"

curl -s "https://graph.facebook.com/$WHATSAPP_GRAPH_VERSION/$WABA_ID/subscribed_apps" \
  -H "Authorization: Bearer $WHATSAPP_ACCESS_TOKEN"
```

The second call must list this app. `GET /$WABA_ID/phone_numbers` should show the sending number
with `webhook_configuration.application` pointing at the callback URL above.

Two things make a missing subscription easy to miss:

- **The dashboard's *Test* button proves nothing about it.** It posts straight to the callback
  whether or not the app is subscribed, so it succeeds either way. Its sample payload carries an
  invented wamid, so it logs `WhatsApp receipts applied` with `applied: 0`, which is correct.
- **Receipts are not replayed.** Messages sent before the subscription existed never get theirs.
  Send a fresh message to test.

**The `messages` field carries both delivery receipts and attendees' own replies, and there is no
setting that takes one without the other.** Discarding replies is therefore the receiver's job, and
it does it: inbound messages are not read, not stored, not logged and not counted. If an attendee
answers the message, nothing here will ever see it — which is a decision, not an oversight, and the
privacy notice depends on it.

### 6. Cloudflare

Recorded in full in [`cloudflare-rules.md`](../infrastructure/cloudflare-rules.md). What the callback depends on:

- **Custom rules 1 and 2 exclude the callback prefix.** Rule 1 blocks every non-BR request and rule
  2 puts a Managed Challenge in front of everything else. Meta delivers from the US, and a server
  cannot solve a challenge, so without the exclusions Meta gets refused, counts every delivery as
  failed, and retries with decreasing frequency for up to seven days until the receipts are simply
  gone — with nothing in our logs to say so, because nothing ever reached the origin.
- **Custom rule 4 blocks everything on that prefix that is not Meta:**

  ```
  starts_with(http.request.uri.path, "/api/v1/whatsapp/webhook/")
  and not (http.request.method in {"POST" "GET"} and ip.geoip.asnum eq 32934)
  ```

  AS32934 is Meta's ASN. This is an edge filter, not the boundary — the signature check is the
  boundary — and it is brittle in one specific way: **if Meta ever delivers from another ASN,
  receipts stop and nothing local says why.** Deleting the rule degrades safely to the method-only
  form.

**Bot Fight Mode is on and does not block Meta's deliveries**, verified on 2026-09-23 when receipts
were applied with it on. No configuration rule is needed.

**No rule may be widened to cover the callback prefix** while receipts matter. A challenge or a
geo block in front of it fails in the silent way described above.

---

## Environment variables

Fifteen values, in three groups. Nothing here is read unless its switch is on.

### Sending

| Variable                         | Required when          | Where it comes from / default                              |
| -------------------------------- | ---------------------- | ---------------------------------------------------------- |
| `WHATSAPP_ENABLED`               | —                      | Master switch for sending. Default `false`                  |
| `WHATSAPP_PHONE_NUMBER_ID`       | `WHATSAPP_ENABLED`     | WhatsApp Manager → Account tools → Phone numbers            |
| `WHATSAPP_ACCESS_TOKEN`          | `WHATSAPP_ENABLED`     | Business Settings → System users. Must be a System User token |
| `WHATSAPP_GRAPH_VERSION`         | —                      | Default `v25.0`. A version deprecation is a `.env` edit, not a deploy |
| `WHATSAPP_DEFAULT_COUNTRY_CODE`  | —                      | Default `55`. Prepended to 10- and 11-digit stored numbers  |
| `WHATSAPP_SEND_INTERVAL_MS`      | —                      | Default `1000`. Milliseconds between messages               |
| `WHATSAPP_REQUEST_TIMEOUT`       | —                      | Default `10s`. Accepts `90s`, `10m`, `4h`                   |
| `WHATSAPP_MAX_ATTEMPTS`          | —                      | Default `3`. Retries of a transient failure before the row fails |

**One second between messages, not the twelve the published rate limit would allow.** The binding
constraint is the number's quality rating rather than throughput, and a burst that reads as
automated costs the number its tier. This is the one default here worth leaving alone.

### Receiving

| Variable                          | Required when                | Where it comes from                                  |
| --------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `WHATSAPP_WEBHOOK_ENABLED`        | —                            | Master switch for receipts. Default `false`           |
| `WHATSAPP_APP_SECRET`             | `WHATSAPP_WEBHOOK_ENABLED`   | Meta App → Settings → Basic. **Not the access token** |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN`   | `WHATSAPP_WEBHOOK_ENABLED`   | You choose it: `openssl rand -hex 32`                 |
| `WHATSAPP_WEBHOOK_PATH_SECRET`    | `WHATSAPP_WEBHOOK_ENABLED`   | You choose it: `openssl rand -hex 32`                 |

**Two of these are values we invent rather than ones Meta issues.** Generate each with its own
`openssl rand -hex 32`, and note where each has to match:

- The **verify token** matches in two places: `.env`, and the callback configuration in Meta's
  dashboard.
- The **path secret** matches in three: `.env`, the callback URL registered with Meta, and the two
  Cloudflare expressions.

The path secret is **noise reduction, not a control.** It keeps opportunistic scanners out of the
logs. The HMAC over the raw body is what refuses a forged request, and nobody may skip that check on
the grounds that the path is hard to guess.

### Door message

| Variable                 | Required when           | Where it comes from / default                                   |
| ------------------------ | ----------------------- | --------------------------------------------------------------- |
| `WHATSAPP_DOOR_ENABLED`  | —                       | Lock on the door message. Default `false`: off whatever the roster switch says |
| `WHATSAPP_DOOR_TEMPLATE` | `WHATSAPP_DOOR_ENABLED` | Sent to participants. A registry key, e.g. `pax_door_v1:pt_BR`. Must allow the participant role |
| `WHATSAPP_DOOR_TEMPLATE_VOLUNTEER` | `WHATSAPP_DOOR_ENABLED` | Sent to volunteers. A registry key that allows the volunteer role. Set both to the same key for one template |
| `WHATSAPP_BUDGET_USD`    | `WHATSAPP_DOOR_ENABLED` | The event's WhatsApp budget, in dollars                          |

See [Door message](#door-message-1) for what these do.

### The two switches are separate, and half-configured refuses to boot

Sending and receiving fail independently, so they have independent switches: a deployment that sends
without a public callback registered is a valid state rather than a broken one.

Within each group, though, the application asserts at boot. Off is valid. Fully configured is valid.
**Half-configured throws before the server listens** — because a missing send credential would
otherwise surface at message one, mid-run, and a missing receipt credential would surface as a
silent `403` back to Meta, which retries for up to seven days while nothing here reports a fault.

The assertion **names every missing key at once**, so a three-secret mistake costs one restart
rather than three.

---

## Verifying the setup

In this order, because each rung depends on the one above.

1. **The application boots.** With both switches on and every credential present, the app starts. If
   it throws, the message names exactly which variables are missing.
2. **The handshake saves.** Press *Verify and Save* in Meta's callback configuration. A success also
   proves the Cloudflare ASN clause is right and the challenge is being dropped on that path.
3. **A test send arrives.** From *Mensagens*, send a test to your own number. **The test send uses
   placeholder values** — a stand-in name and ticket code — so no attendee's real entry credential
   can ever reach a number typed into that box. You are testing the template, the token and the
   number, not the data.
4. **The receipt comes back.** A test send writes no `whatsapp_sends` row by design, so its receipts
   arrive and log `WhatsApp receipts applied` with `applied: 0`, and the screen does not move. Seeing
   that log line at all proves the subscription, the edge and the app secret.
5. **A real run.** Preview first: the count and a sample of masked numbers. Then start it. Its
   receipts log `applied: 1` each, and `entregues` then `lidos` move on the screen. **If the sends
   work and nothing is ever logged, the problem is the subscription, the app secret or the edge** —
   see the table below.

---

## When something breaks

| Symptom                                           | Almost certainly                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| `403` on every receipt; sends fine                | `WHATSAPP_APP_SECRET` holds the access token, or the wrong app's secret  |
| Every message fails with `132000`                 | The template's body variable count differs from the registry's `body`    |
| Every message fails with `132001`                 | Language code — `pt-BR` instead of `pt_BR`                               |
| A run dies partway with `190`                     | The token is a user or page token, not a System User token, and expired  |
| The subscription will not save                    | Cloudflare — the ASN clause, or a rule no longer excluding that path     |
| Test webhooks arrive, real receipts never do      | The app is not subscribed to the WABA — see step 5                       |
| Delivered counts never move at all                | The `messages` field is not subscribed, or only test sends were made     |
| Receipts stop, sends still working                | Meta delivering from outside AS32934, or a Cloudflare rule changed       |
| One number is `undelivered`, the rest are fine    | That number — not registered on WhatsApp, or unnormalisable in the roster |

**Where to look.** The *Limits* panel on the admin shell shows the limiter keys moving
(`rl:ip:whatsapp-webhook` and `rl:global:whatsapp-webhook` for receipts). `app_events` carries the
security and failure records. Two alert rules fire on their own: a **run stalled** for five minutes,
and a **finished run with more than 30% undelivered** — a scatter is ordinary, a majority is a
number-quality problem in the roster rather than a fault here.

**The logs will not name a phone number**, in any of these cases. That is deliberate; see below.

---

## Operating notes

What the screen does not tell you, and what to do before and after a run.

**Before each event**

- **Re-read the messaging-limit tier.** See [Before you start](#before-you-start). It belongs to the
  Meta portfolio, not this repository.
- **Check the roster's numbers before the week of the event.** Numbers that cannot be normalised,
  such as 12-digit ones, are refused rather than repaired and show as `skipped` in the preview. A
  meaningful share of `131026` usually means stored numbers missing, or wrongly carrying, the
  mobile ninth digit. Compare `wa_id` with `to_e164` and fix the rows in the attendees editor.

**During a run**

- **`interrupted` needs a person.** A container killed between claiming a row and Meta's answer
  leaves a message whose fate cannot be known locally. Nothing retries it automatically; the
  operator decides whether *Reenviar interrompidos* is safe.
- **The progress panel stops polling when the run is `done`.** Receipts that arrive later are stored
  but not shown until the page is reloaded.

**After a run**

- **Receipts keep arriving after the operator has gone home.** `delivered` for a phone that was off
  can be hours late. There is no "all receipts in" state.
- **`lidos` under-reports.** Read receipts are a recipient setting, and a `read` that never comes is
  indistinguishable from one the recipient suppressed.
- **An attendee added after a run gets nothing.** Re-running the same template and role is safe:
  the preview counts those already sent and sends only to the new rows.
- **A receipt that matches no row is normal**: a test send, or a row purged since. The callback
  still answers `200`, because anything else makes Meta retry something that will never match.

**Accepted limits**

- **Replies are discarded unread, so an opt-out sent by reply is never seen.** Honouring it would
  mean building an inbox. The template invites no reply, and the roster is people who signed up for
  this event.
- **The entry token is a live credential sitting in attendees' chats.** Rotating
  `ticket_link_token` in `purge-attendees.sql` is how those links are revoked.
- **The ASN pin fails silently.** If receipts stop for a finished run, check Security → Events for
  custom rule 4 before anything else.

---

## Door message

`/admin/attendees` can send a template on the spot — the entry link — in two cases: to somebody who
signs up at the door, and to an attendee whose stored number was wrong (a typo, or a parent's number)
once it has been corrected. It is separate from runs: nothing on `/admin/whatsapp` shows, starts or
is stopped by it.

The template follows the attendee's role as saved: participants get `WHATSAPP_DOOR_TEMPLATE`,
volunteers `WHATSAPP_DOOR_TEMPLATE_VOLUNTEER`. The budget and availability shown before the role is
known, on the blank form and the roster panel, use the dearer of the two.

**Four things must all allow a message, and each has a different owner.**

1. **`.env`** — `WHATSAPP_ENABLED` and `WHATSAPP_DOOR_ENABLED`. Only somebody on the host can open
   this lock. Closed, the form shows no checkbox and the switch below cannot be turned on.
2. **The switch** on `/admin/attendees`, shown to administrators holding `whatsapp:send`. Stored in
   `whatsapp_door_state`, so it survives a restart. It **starts off**: opening the `.env` lock sends
   nothing until somebody turns it on. Other instances see a change within five seconds.
3. **The budget**, `WHATSAPP_BUDGET_USD`. Spend is every message Meta accepted this event — bulk
   runs included — plus door messages in flight, priced at `TEMPLATE_PRICE_USD`. A door message is
   sent only if it still fits. Meta bills delivered messages only, so this is an upper bound and door
   messages cannot overshoot it.
4. **The operator**, per save: the checkbox on the form. On the blank form it starts ticked when
   the three above allow it. On an existing record it starts unticked and **ticks itself when the
   phone field is changed**, unticking again if the change is undone. Untick it when the person does
   not want it, when WhatsApp is misbehaving, or when told to stop.

Then three limits, whoever asks:

- **One door message per number.** A number that has received one, or has one in flight, is never
  sent another, whichever attendee it belongs to — so a parent's number shared by two children gets
  one. Bulk runs do not count here: an attendee whose run went to the wrong number can still be sent
  to the right one. A **failed** send frees the number, since nothing reached it.
- **At most three door messages per attendee**, failed ones not counted, so a record cannot be
  cycled through number after number.
- **30 door messages per account in ten minutes** (`rl:admin:whatsapp-door`), so one volunteer who
  does not know messages cost money cannot spend the budget in minutes. A save that would only repeat
  a message to a number that already has it costs nothing against this.

**The record is always saved.** The message goes once the attendee is created or the corrected number
committed, to the number now stored. Whatever becomes of it, a toast says whether it was sent,
refused by Meta, or skipped and why. Anything but "sent" means handing the code over another way.

**Bulk runs are counted, never stopped.** A large run started while door messages are live can
take total spend past the budget; door messages then stop and the run carries on. Budget runs
before starting them.

**Door messages have no delivery receipts.** Their `wamid` matches no `whatsapp_sends` row, so the
callback ignores them, as it does any unmatched receipt. Spend counts them from acceptance anyway.

At the 17/10 event 26 door sends failed on network timeouts and DNS failures, and nothing retried
them ([event report](../reports/event-2026-10-17.md#door-messages)).

A row left `sending` — the process died between reserving and Meta's answer — keeps counting as
spend. That errs towards stopping early, and nothing retries it.

---

## Privacy

Three guarantees hold across this whole feature, and they constrain what troubleshooting is
possible — which is the trade, made on purpose.

- **No phone number reaches a log line, an alert, or an `app_events` row.** Meta sends one on every
  single receipt; it is read and discarded. `data-retention.md` promises the operation logs carry
  none, and this is what keeps that true.
- **The preview never renders an entry link or a token.** It shows counts and masked numbers.
- **The entry token exists only inside Meta's approved button URL.** We send a bare token; the
  scheme, host and path are Meta's. No complete, working entry link is ever composed on this side.

Everything personal that this feature writes lives in `whatsapp_runs` and `whatsapp_sends`, both of
which are destroyed with the `data` volume roughly 24 hours after the event. If a database dump has
to outlive the host, `scripts/db/purge-phone.sql` redacts the phone number, `wa_id` and `wamid`
columns along with the rest. See [`data-retention.md`](../security/data-retention.md).
