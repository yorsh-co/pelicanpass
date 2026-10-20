# Copy Management

How user-facing text is stored, read, checked, reviewed and translated. This is the
reference for working with copy today. The design record and build log are in git history
(see [History](#11-history)).

Two audiences: developers read all of it; the person who reviews the wording needs only
[For the copy reviewer](#10-for-the-copy-reviewer).

---

## 1. What this is

**Every user-facing string lives in an ICU MessageFormat catalog** under
`src/i18n/messages/pt-BR/`, with one JSON file per surface (a _namespace_). Code never
writes copy inline. It calls typed accessors generated from those catalogs, so a
misspelled message name or a missing argument fails `tsc` instead of rendering
`undefined`.

- **pt-BR is the source of truth.** It defines every message and every argument's type,
  and it is what any other locale falls back to.
- **Every namespace is translatable, admin screens included.** A locale is published only
  when all of them are translated, so staff and attendees get the same language.
  `translatable: false` still exists for a surface that must stay pt-BR; none uses it.
- **`en-XA` is a pseudo-locale.** It is pt-BR with accents, padding and brackets, for
  spotting text that escaped the catalogs. It exists only outside production.

Deliberate exceptions:

| Text                                        | Where it lives, and why                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| JSON API `error` strings                    | Inline English: they are for developers; clients branch on `code` and, for admin refusals, `details.reason` |
| Meta's failure titles on the WhatsApp panel | Shown as Meta sends them (English); codes this app writes are named from `admin-whatsapp` |
| Alert titles on the metrics panel           | English, as sent to Discord                                               |
| WhatsApp message bodies                     | Approved by Meta and edited in WhatsApp Manager, never in this repo       |
| Privacy notice and terms                    | Markdown in `src/web/content/<locale>/`, owned by whoever owns the policy |
| Questionnaire questions                     | Markdown in `src/web/content/<locale>/survey-participant.md` and the optional `survey-volunteer.md`, validated by `survey:check`. The card's own copy is the `survey` namespace |
| Brand names, icon ligatures, code literals  | Inline, since they are not copy: "PelicanPass", `check`, `dXXXXX`         |

## 2. Map of the pieces

| Path                                   | Role                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| `src/i18n/messages/pt-BR/<ns>.json`    | Source catalogs. Hand-edited, or reworded from a TMS review by `i18n:import-source`.   |
| `src/i18n/messages/<locale>/<ns>.json` | Translations. Written by `i18n:import` only; never hand-edited.                        |
| `src/i18n/generated/`                  | Typed accessors and precompiled catalogs. **Committed; never edited.**                 |
| `src/i18n/locales.ts`                  | `LOCALES`, `BASE_LOCALE`, `PSEUDO_LOCALE`, `DRAFT_LOCALES`, `META_LANGUAGE`, `supportedLocales` |
| `src/i18n/namespaces.ts`               | `NAMESPACES`: every namespace and whether it is translatable                           |
| `src/i18n/server.ts`                   | `localeMiddleware`, `resolveLocale`, `LocaleLink`; re-exports the accessors below          |
| `src/i18n/catalogs.ts`                 | `getMessages`, `getCopy`, `inlineCatalogs`. Reads no environment, so the landing fallback can use it |
| `src/web/client/core/i18n.ts`          | `readMessages`: a page's accessors, built from the catalog its route inlined           |
| `src/web/views/partials/i18n-catalogs.ejs` | Writes the inlined catalogs as `<script type="application/json">` blocks           |
| `scripts/i18n/generate.ts`             | Compiles every catalog and produces the accessors (writes nothing)                     |
| `scripts/i18n/build.ts`                | `i18n:build`: writes `generate.ts`'s output and prunes stale files                     |
| `scripts/i18n/check.ts`                | `i18n:check`: generated output is fresh, catalogs are valid, templates call real messages |
| `scripts/i18n/inventory.ts`            | `i18n:inventory`: writes `docs/development/copy-inventory.md`; `--check` fails if it is stale      |
| `scripts/i18n/audit-strings.ts`        | `i18n:audit`: fails when client code writes a literal to the page                      |
| `scripts/i18n/export.ts`, `import.ts`, `tms-formats.ts` | `i18n:export` / `i18n:import`: the round trip with a translation system |
| `scripts/i18n/import-source.ts`        | `i18n:import-source`: brings reviewed pt-BR wording back from a TMS export             |
| `scripts/i18n/inline-copy.ts`          | Heuristics behind the inventory's "not yet migrated" counts                            |
| `src/types/admin-refusal.ts`           | `AdminRefusal`: why an admin request was refused, named from `admin-errors`            |
| `src/web/client/pages/admin/shared/refusal.ts` | `refusalMessage`: an admin refusal's message                                   |
| `src/types/limiter.ts`, `src/modules/metrics/metrics.labels.ts` | Limiter codes the metrics snapshot carries, and their names  |
| `src/modules/whatsapp/whatsapp.run-codes.ts` | Names for stored WhatsApp stop reasons and failure codes                         |
| `docs/development/copy-inventory.md`               | The generated review document                                                          |
| `src/modules/survey/survey.definition.ts` | Parses the questionnaire files at boot; `surveyFor` serves them                     |
| `scripts/survey/check.ts`              | `survey:check`: fails when a questionnaire file could not be served                    |

## 3. Writing a message

```json
{
  "staff.band.retry": {
    "defaultMessage": "Atualizar",
    "description": "Replaces the band word when it stops refreshing. A stale band on this screen is the dangerous one: a volunteer comparing against it would reject a legitimate pass, so the word is replaced rather than left looking current."
  }
}
```

- **IDs are `<namespace>.<group>.<key>`**, stable and hierarchical. They are what a
  reviewer quotes and what a translation system keys on, so renaming one is a real change.
  Keep each file sorted by ID.
- **The accessor name is the ID without the namespace, in camelCase.** For example,
  `staff.band.retry` becomes `bandRetry()` and `admin-shell.pager.position` becomes
  `pagerPosition()`. The factory is `create<Namespace>Messages` (`createStaffMessages`,
  `createAdminShellMessages`).
- **A description is required** (`i18n:build` fails on an empty one). Write it for a
  translator and a reviewer: where the text appears, what it must convey and any
  constraint. Say _why_, not what the words say.

**ICU, as used here.** The codegen types each argument from the pt-BR message:

| In the message                               | Accessor argument                              |
| -------------------------------------------- | ---------------------------------------------- |
| `{n, plural, …}`, `{n, number}`              | `number`                                       |
| `{audience, select, participant {…} volunteer {…} other {…}}` | `'participant' \| 'volunteer'` (named cases only) |
| `{when, date}` / `{when, time}`              | `Date`                                         |
| `{name}`                                     | `string`                                       |

Rules that have already caught someone out:

- **Whole sentences only.** Never join two messages, or a message and a literal, in code.
  A sentence with a variable part is one message with an argument.
- **In pt-BR, the `one` plural category also covers 0.** `{n, plural, one {# item} other
  {# itens}}` renders "0 item". To match an `n === 1` rule, write `=1 {…}`.
- **Numbers that must not be grouped** (counts written as `String(n)` before, IDs, years)
  use `{n, number, ::group-off}`. `#` and `{n, number}` render 1000 as "1.000".
- **A select must list every case** the code passes (it is typed from the named cases),
  plus `other`, which is only a fallback. A select argument cannot also be printed as a
  plain `{status}` elsewhere in the same message.
- **No tags.** The codegen rejects `<b>` and friends. Where a sentence contains a link,
  bold text or code, split it into pieces rendered around the markup, and describe each
  piece as part of the whole (see `admin-whatsapp.note.sent.lead` / `.rest`). Brand names
  and code values stay in the template.
- **`#` outside a plural is a literal:** `Presente · #{number, number, ::group-off}`.
- **Audience differences use `select`,** so every audience gets a complete sentence and a
  translator sees all the forms side by side (see `checkin.ticket.defaultHint`).

Two real messages that apply several of these rules at once:

```json
"admin-lookup.record.presentNumber": {
  "defaultMessage": "Presente · #{number, number, ::group-off}",
  "description": "Presence of an attendee who checked in and holds arrival number {number}."
},
"admin-whatsapp.run.status": {
  "defaultMessage": "{status, select, running {Em andamento} paused {Pausado} done {Concluído} failed {Interrompido} other {Desconhecido}}",
  "description": "A run's status. other is only a fallback for a status the server does not send today."
}
```

The first has a literal `#` and an ungrouped number. The second is a select whose type is
`'done' | 'failed' | 'paused' | 'running'`. Worked recipes are in section 6.

## 4. Reading copy

### On the server

```ts
import { getMessages } from '../../i18n/server.ts';

const m = getMessages(res.locals.locale, 'errors');
m.rateLimitedMessageWithRetry({ unit: 'minutes', count: 2 });
```

- `getMessages` is memoised per locale and namespace, so it is cheap to call per request.
- `res.locals.chrome` is the shared `chrome` namespace in the response's locale. It is set
  on every response, including errors raised before the router.
- `res.locals.shell` is `admin-shell` in the response's locale, set on admin pages by
  `adminChrome`.
- **Read messages per request, never once at module scope**: a value built at startup is
  frozen in one language. `web.routes.ts` does it with `adminMessages(res)`.
- An API handler has no `res.locals.locale`; it calls `resolveLocale(req)` (cookie, then
  `Accept-Language`), as the admin identity endpoint does.

### In EJS

```ejs
<%# i18n: checkin, qr %>
<h1><%= copy.ticketHeader() %></h1>
<button><%= copy.cameraButton() %></button>
<footer><%= chrome.footerPrivacy() %></footer>
```

```ts
res.render('pages/attendee/checkin/checkin', {
  copy: getCopy(res.locals.locale, ['checkin', 'qr']),
  // …
});
```

- **The first line declares the namespaces** the template reads through `copy`.
  `i18n:check` fails if a `copy.x()` names a message none of them has, or if two of them
  share an accessor name. The route must pass `getCopy` with the same list; nothing checks
  that pairing, so keep them next to each other in review.
- **`chrome.x()` and `shell.x()` need no header.** They are response locals, and
  `i18n:check` validates them in every template.
- **Partials** that read `copy` carry their own header (`components/pass.ejs`), and the
  including route's `getCopy` must cover them.
- **Never pass a render local named `body`.** express-ejs-layouts hands the rendered page
  to the layout as `body` and then copies render options over it, so such a local silently
  replaces the whole page. The error page names its local `message` for this reason.
- EJS escapes `<%= … %>`, so message text needs no escaping of its own.

### In client scripts

The route inlines the page's catalogs; the page builds its strings once:

```ts
// route
res.render('pages/attendee/staff/scan', {
  messages: inlineCatalogs(res.locals.locale, ['staff', 'qr', 'chrome']),
});
```

```ejs
<%- include('../../../partials/i18n-catalogs') %>
```

```ts
// pages/attendee/staff/messages.ts
import { createStaffMessages } from '../../../../../i18n/generated/staff.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const staff = readMessages('staff', createStaffMessages);

export const STAFF_COPY = {
  lookupFailed: staff.lookupFailed(),
  outcome: (item: RedemptionItem, outcome: RedemptionOutcome): string => …,
} as const;
```

- **Inline only the namespaces the page's script reads.** Each one is shipped in the HTML.
- **The catalogs are precompiled,** and the ICU parser never reaches a bundle: esbuild
  aliases it away. Do not import `@formatjs/icu-messageformat-parser` from client code.
- `readMessages` takes the locale from `<html lang>`, which only the server writes.
- **Static text belongs in the template,** not in a script, so it is there with
  JavaScript off. A script writes only what changes after load.
- **For a label or two on a shared control,** render them as `data-label-*` attributes
  instead of inlining a catalog on every page. The theme toggle (`theme.ts`) and the admin
  menu button (`admin/shell/index.ts`) do this.

### Label maps in `src/constants`

The keys in `REDEEMABLE_ITEMS`, `ADMIN_SCOPE_VALUES`, `ADMIN_NAV`, the attendee filters,
`WHATSAPP_TEMPLATES` and `TEMPLATE_VARIABLES` are contracts: database constraints,
permission scopes, the privacy-governed variable set. **The keys stay in the constant; the
labels live in the catalog**, and the code that renders them pairs the two through a map
that has to list every key:

```ts
const NAV_LABELS: Record<AdminNavKey, (shell: MessagesOf['admin-shell']) => string> = {
  attendees: (shell) => shell.navAttendees(),
  // … every key, or typecheck fails
};
```

See `adminChrome` (`src/middleware/admin-chrome.middleware.ts`), `scopeLabels` in
`admin.controller.ts`, `filterLabels` / `templateCopy` / `variableLabels` in
`web.routes.ts`, and `metricsLabels`.

Server-side prose that a page shows follows the same rule: the server sends a **code**
and the page names it. The rate-limiter registry declares `keyedOn` / `protects` as
`LimiterKeyBasis` / `LimiterPurpose` codes, and the WhatsApp runner stores codes such as
`CIRCUIT_BREAKER`, named by `whatsapp.run-codes.ts`.

## 5. Locales at runtime

`localeMiddleware` (mounted in `web.routes.ts`) resolves each request's locale:

1. **`?lang=<tag>`** for a supported locale sets the `locale` cookie (one year, httpOnly)
   and redirects with a 303 to the same URL without `lang`.
2. **The `locale` cookie.**
3. **`Accept-Language`,** matched against the offered locales. Malformed tags are ignored
   and the pseudo-locale is never matched.
4. **pt-BR.**

It sets `res.locals.locale`, `chrome` and `localeLinks`, plus `Content-Language`,
`Vary: Cookie, Accept-Language` and `Cache-Control: private` (unless a stricter value is
already set). A shared cache must never serve one visitor's language to another.

- **Offered locales:** `supportedLocales(NODE_ENV)`. In production that is `LOCALES`
  minus the pseudo-locale and minus `DRAFT_LOCALES`; in development it is everything.
- **Admin pages follow the same locale** as the public ones, `/admin/login` included.
- **The language switcher** renders in the public footer and in the admin rail when more
  than one locale is offered, so today it shows in development (pt-BR and `en-XA`) and not
  in production. Both are the same native `<details>` menu, placed after the theme toggle:
  the toggle shows the current locale's two-letter region code (`Intl.Locale#maximize`),
  and the panel lists each locale as that code and its name in its own language, through
  `Intl.DisplayNames`.
- **Long-form pages** read `src/web/content/<locale>/*.md` at boot; a locale without its
  own file is served the pt-BR text.
- **`Intl` formatting** (dates, times) uses the resolved locale on the server and
  `<html lang>` in the browser.

## 6. Recipes

Every recipe ends with `npm run check`. The "add" recipes use two examples that do
**not** exist in the code: the message `raffle.drawnTotal` and a `feedback` page. Both
were applied as shown, built, checked and reverted, to prove the snippets hold. Every
other snippet is quoted from the code, and every error is real output.

### Change the wording of a message

1. Edit `defaultMessage`, and the `description` if the reason changed:

   ```diff
     "raffle.idle": {
   -   "defaultMessage": "Toca em gerar para começar",
   +   "defaultMessage": "Toque em gerar para começar",
       "description": "Hint under the empty number, before the first draw …"
     },
   ```

2. Regenerate and commit the three paths together:

   ```bash
   npm run i18n:build && npm run i18n:inventory
   git add src/i18n/messages src/i18n/generated docs/development/copy-inventory.md
   ```

Changing an **argument** changes the accessor's signature, and `typecheck` then names
every call site. Renaming `{checkinNumber}` to `{number}` in `raffle.resetLabel`:

```diff
- "defaultMessage": "Devolver #{checkinNumber, number, ::group-off} aos restantes",
+ "defaultMessage": "Devolver #{number, number, ::group-off} aos restantes",
```

```text
src/web/client/pages/attendee/raffle/index.ts(62,39): error TS2353: Object literal may
only specify known properties, and 'checkinNumber' does not exist in type
'{ number: number; }'.
```

### Add a message

1. Add the entry to the namespace's catalog, in ID order:

   ```json
   "raffle.drawnTotal": {
     "defaultMessage": "{count, plural, =1 {# número gerado} other {# números gerados}}",
     "description": "Total under the drawn list. Shown from zero, so the singular is =1 rather than one."
   },
   ```

2. `npm run i18n:build`. `src/i18n/generated/raffle.messages.ts` gains a typed accessor,
   and the description becomes its JSDoc:

   ```ts
   /** Total under the drawn list. Shown from zero, so the singular is =1 rather than one. */
   drawnTotal: (values: { count: number }): string =>
     format('raffle.drawnTotal', values),
   ```

3. Use it where it is needed.

   **On the server:**

   ```ts
   const raffle = getMessages(res.locals.locale, 'raffle');

   raffle.drawnTotal({ count: 0 }); // "0 números gerados"
   ```

   **In a template.** The route already passes `copy` for the namespace; the `/raffle`
   route is shown as it stands:

   ```ts
   res.render('pages/attendee/raffle/draw', {
     title: res.locals.chrome.titleRaffle({ appTitle: env.appTitle }),
     // …
     messages: inlineCatalogs(res.locals.locale, ['raffle']),
     copy: getCopy(res.locals.locale, ['raffle']),
   });
   ```

   ```ejs
   <%# i18n: raffle %>
   <%- include('../../../partials/i18n-catalogs') %>

   <p data-raffle="total"><%= copy.drawnTotal({ count: 0 }) %></p>
   ```

   A template reading a namespace for the first time needs it in **both** the header line
   and the route's `getCopy` list.

   **In the page's script.** `raffle/index.ts` builds its accessors directly, and the
   route already inlines `raffle`:

   ```ts
   const copy = readMessages('raffle', createRaffleMessages);

   // in render(), which runs after every server response
   dom.total.textContent = copy.drawnTotal({ count: view.draws.length });
   ```

   Pages with more to say keep a `messages.ts` that builds the strings once and exports
   one object, which the rest of the page imports:

   ```ts
   // pages/attendee/staff/messages.ts (trimmed)
   const staff = readMessages('staff', createStaffMessages);

   export const STAFF_COPY = {
     lookupFailed: staff.lookupFailed(),
     redeemFailed: staff.redeemFailed(),
     /** The line shown after a redemption attempt. */
     outcome: (item: RedemptionItem, outcome: RedemptionOutcome): string =>
       OUTCOMES[outcome]({ item: itemLabel(item) }),
   } as const;
   ```

   If the script reads a namespace the route does not inline yet, add it to the route's
   `inlineCatalogs` list. `readMessages` throws `missing inlined catalog: <ns>` otherwise.

4. `npm run i18n:inventory`.

### Add a plural or select message

**Plurals.** In pt-BR, CLDR puts 0 in `one`, so pick the form deliberately:

| Message                                              | `count: 0`         | `count: 1`          |
| ---------------------------------------------------- | ------------------ | ------------------- |
| `{count, plural, one {# item} other {# itens}}`       | 0 item             | 1 item              |
| `{count, plural, =1 {# item} other {# itens}}`        | 0 itens            | 1 item              |

`#` and `{count, number}` group thousands (`1.000`). For a value that was written raw
before, or that is an identifier, turn grouping off:

```json
"raffle.resetLabel": {
  "defaultMessage": "Devolver #{checkinNumber, number, ::group-off} aos restantes",
  "description": "… The number is a check-in number and is never grouped."
}
```

**Selects.** List every value the code passes; `other` is only a fallback.

```json
"checkin.ticket.defaultHint": {
  "defaultMessage": "{audience, select, participant {Digite o código recebido por WhatsApp} volunteer {Digite seu código de checkin} other {Digite o código recebido por WhatsApp}}",
  "description": "Hint under the code field. …"
}
```

```ts
checkin.ticketDefaultHint({ audience }); // audience: 'participant' | 'volunteer'
```

Passing a value the message does not list is a type error:

```text
error TS2322: Type '"staff"' is not assignable to type '"participant" | "volunteer"'.
```

**Sentences around markup.** Split a sentence around bold text, a link or code into
pieces, and say in each description how they join. `admin-whatsapp.note.sent.*` renders
as:

```json
"admin-whatsapp.note.sent.lead": {
  "defaultMessage": "“Enviado” significa que a Meta aceitou a mensagem",
  "description": "Bold opening of the delivery note, continued by admin-whatsapp.note.sent.rest. …"
},
"admin-whatsapp.note.sent.rest": {
  "defaultMessage": ", não que alguém a recebeu. “Entregues” e “lidos” chegam depois, por confirmação da Meta.",
  "description": "Continues admin-whatsapp.note.sent.lead in the same sentence, hence the leading comma."
}
```

```ejs
<strong><%= copy.noteSentLead() %></strong><%= copy.noteSentRest() %>
```

### Remove or rename a message

1. Find the callers by **accessor** name, not by ID:

   ```bash
   grep -rn "drawnTotal" src --exclude-dir=generated
   ```

2. Change the catalog, then `npm run i18n:build`. The accessor disappears from
   `raffle.messages.ts`.
3. Whatever still calls it fails. Templates fail in `i18n:check`:

   ```text
   i18n: views/pages/attendee/raffle/draw.ejs: raffle has no message "drawnTotal"
   i18n: run `npm run i18n:build` after fixing the catalogs; see docs/development/copy-management.md
   ```

   Scripts fail in `typecheck`:

   ```text
   src/web/client/pages/attendee/raffle/index.ts(107,32): error TS2339: Property
   'drawnTotal' does not exist on type '{ counters: …; drawButton: …; … }'.
   ```

4. A rename changes the Ref that reviewers and translators use, so say so in the commit
   message.

### Add a namespace

The example is a hypothetical `feedback` page.

1. Register it. Use `translatable: false` only for a surface that must stay pt-BR in every
   locale.

   ```ts
   // src/i18n/namespaces.ts
   export const NAMESPACES = [
     // …
     { name: 'qr', translatable: true },
     { name: 'feedback', translatable: true },
     // …
   ] as const;
   ```

2. Create `src/i18n/messages/pt-BR/feedback.json`:

   ```json
   {
     "feedback.heading": {
       "defaultMessage": "Conte o que achou",
       "description": "Heading of the feedback page."
     },
     "feedback.sent": {
       "defaultMessage": "Obrigado, {name}!",
       "description": "Shown once the form is sent. {name} is the attendee's first name."
     }
   }
   ```

3. `npm run i18n:build && npm run i18n:inventory` writes:

   ```text
   src/i18n/generated/feedback.messages.ts   createFeedbackMessages, FeedbackMessages
   src/i18n/generated/pt-BR/feedback.ts      precompiled catalog
   src/i18n/generated/en-XA/feedback.ts      pseudo-localised catalog
   src/i18n/generated/registry.ts            'feedback' registered
   ```

   It also adds a `feedback` section to the inventory. `getMessages(locale, 'feedback')`,
   `getCopy(…, ['feedback'])` and `inlineCatalogs(…, ['feedback'])` now type-check.

### Add a screen

The hypothetical `feedback` page from the previous recipe, end to end.

**The title,** in `chrome.json`:

```json
"chrome.title.feedback": {
  "defaultMessage": "Sua opinião | {appTitle}",
  "description": "Browser tab title of the feedback page. {appTitle} is the application's name."
}
```

**The route:**

```ts
router.get('/feedback', requireWebAuth('attendee', '/checkin'), (_req, res) => {
  res.render('pages/attendee/feedback', {
    title: res.locals.chrome.titleFeedback({ appTitle: env.appTitle }),
    copy: getCopy(res.locals.locale, ['feedback']),
    messages: inlineCatalogs(res.locals.locale, ['feedback']),
  });
});
```

**The template,** `src/web/views/pages/attendee/feedback.ejs`. Static text is rendered by
the server:

```ejs
<%# i18n: feedback %>
<%- include('../../partials/i18n-catalogs') %>

<main class="main-container">
  <h1><%= copy.heading() %></h1>
  <p data-feedback="status" aria-live="polite"></p>
</main>

<%- contentFor('scripts') %>
<script type="module" src="/js/pages/attendee/feedback/index.js"></script>
```

**The script's copy,** `src/web/client/pages/attendee/feedback/messages.ts`:

```ts
import { createFeedbackMessages } from '../../../../../i18n/generated/feedback.messages.ts';
import { readMessages } from '../../../core/i18n.ts';

const feedback = readMessages('feedback', createFeedbackMessages);

/** What the feedback page's script writes. */
export const FEEDBACK_COPY = {
  sent: (name: string): string => feedback.sent({ name }),
} as const;
```

**The script,** `index.ts`, writes only what changes after load:

```ts
import { qs } from '../../../layouts/main/dom.ts';
import { FEEDBACK_COPY } from './messages.ts';

// firstName comes from the page's own data
qs('[data-feedback="status"]').textContent = FEEDBACK_COPY.sent(firstName);
```

Then walk the page under `?lang=en-XA` (the last recipe).

### Add a labelled constant

The key set stays in `src/constants`, as values only:

```ts
// src/constants/attendee-filters.ts
export const ROLE_FILTERS = ['participant', 'all', 'volunteer'] as const;
```

Each key gets a message:

```json
"admin-shell.filter.role.all": { "defaultMessage": "Participantes + voluntários", "description": "…" },
"admin-shell.filter.role.participant": { "defaultMessage": "Participantes", "description": "…" },
"admin-shell.filter.role.volunteer": { "defaultMessage": "Voluntários", "description": "…" }
```

The code that renders them pairs the two through a map that must list every key, built
from the messages of the request being answered. `web.routes.ts`:

```ts
const filterLabels = (shell: MessagesOf['admin-shell']) => ({
  roleFilters: labelled(ROLE_FILTERS, {
    participant: shell.filterRoleParticipant(),
    all: shell.filterRoleAll(),
    volunteer: shell.filterRoleVolunteer(),
  }),
  // …
});

// in the route
const m = adminMessages(res);

res.render('pages/admin/attendees/list', { ...filterLabels(m.shell) /* … */ });
```

`adminChrome` does the same with a map of functions:

```ts
const NAV_LABELS: Record<
  AdminNavKey,
  (shell: MessagesOf['admin-shell']) => string
> = {
  attendees: (shell) => shell.navAttendees(),
  // …
  admins: (shell) => shell.navAdmins(),
};

const shell = getMessages(res.locals.locale, 'admin-shell');

res.locals.adminNav = ADMIN_NAV.filter((item) =>
  scopes.includes(item.scope),
).map((item) => ({ ...item, label: NAV_LABELS[item.key](shell) }));
```

A new key without a label fails `typecheck`:

```text
src/middleware/admin-chrome.middleware.ts(12,7): error TS2741: Property 'admins' is
missing in type '{ attendees: (shell: { … }) => string; … }' but required in type
'Record<AdminNavKey, (shell: { … }) => string>'.
```

### Refuse an admin request

One `CONFLICT` or `VALIDATION_ERROR` covers several refusals, so an admin service names
which one with `details.reason` and never puts copy in the error message.

1. Add the reason to `AdminRefusal` (`src/types/admin-refusal.ts`).
2. Add `admin-errors.<reason>` to the catalog, and build.
3. Add it to the map in `pages/admin/shared/refusal.ts`; `typecheck` fails until you do:

   ```text
   src/web/client/pages/admin/shared/refusal.ts(14,7): error TS2741: Property 'zzProbe'
   is missing in type '{ attendeeArchived: () => string; … }' but required in type
   'Record<AdminRefusal, (details: ApiErrorDetails) => string | undefined>'.
   ```

4. Throw it with an English diagnostic:

   ```ts
   throw new ConflictError('Ticket code taken', { reason: 'ticketCodeTaken' });

   // a refusal about one item carries it, for the message's {item} select
   throw new ConflictError(`Cannot clear redeemed ${item}`, {
     reason: 'itemAlreadyRedeemed',
     item,
   });
   ```

The page shows it with `refusalMessage(err) ?? fallback`, and its route inlines
`admin-errors`. An accented literal in `src/modules/admin` fails lint, which keeps pt-BR
out of the diagnostics.

### Edit the privacy notice or the terms

Edit `src/web/content/pt-BR/privacy-notice.md` or `terms-of-use.md`, then restart: the
files are parsed at boot. A locale is served its own file only if one exists, which is
why an unreviewed translation must never be added:

```ts
// web.routes.ts
const readNotice = (locale: Locale, file: string): string => {
  const localised = new URL(`../content/${locale}/${file}`, import.meta.url);
  const source = existsSync(localised)
    ? localised
    : new URL(`../content/${BASE_LOCALE}/${file}`, import.meta.url);

  return renderMarkdown(readFileSync(source, 'utf8'));
};
```

`renderMarkdown` (`src/shared/utils/markdown.ts`) escapes raw HTML, so write notices in plain
Markdown. A link or image is rendered only when its address is relative or uses `http`,
`https` or `mailto`; any other link shows its text alone and any other image its alt text.

The Markdown files, notices and questionnaires alike, may name the event or its organiser with a
`{name}` placeholder such as `{eventName}`. It is filled from `COPY_DEFAULTS`
(`src/constants/copy-defaults.ts`) before the file is rendered or parsed, and an unknown name
fails the boot. Square-bracket markers such as `[RAZÃO SOCIAL]` are not placeholders: they are
fields the operator fills in by hand.

### Edit the questionnaire

The questions are `src/web/content/pt-BR/survey-participant.md` and, if volunteers have a
questionnaire, `survey-volunteer.md` beside it. Whether each form is live is set in `.env`,
not here: see the last rule below. Each file is one `#` title, an optional
intro, then one `##` per question with its properties and an optional one-paragraph hint:

```md
## Você participaria da próxima edição?

- id: would_return
- type: yes-no
- required: yes
```

`type` is `rating` (1 to 10), `yes-no` or `text`. `max-length` goes only on `text`, from 1
to 1000, and defaults to 500. A file's text questions may allow 2000 characters in all, so a
full submission fits the API's 10 KB request limit. The full grammar is in
[`survey.md`](../features/survey.md#the-questions-files). Run
`npm run survey:check` after every edit, then commit and redeploy: the files are parsed at
boot.

- **Wording can change at any time.** Forms already open still submit.
- **Adding a question is safe.** Forms already open reload to show it.
- **Removing a question keeps its answers.** They move to `other_answers` in the export.
- **Never change an `id` or `type` once the survey has opened.** Earlier answers stay under
  the old key or in the old shape. Nothing enforces this, because the check cannot see
  the database.
- **The file holds the questions; `.env` turns the form on.** `SURVEY_PARTICIPANT_ENABLED`
  and `SURVEY_VOLUNTEER_ENABLED` switch each form. A drafted `survey-volunteer.md` is safe
  to commit with its switch off, and `survey:check` validates it either way. Switching the
  volunteer form on without the file stops the app from booting. Answers already collected
  stay in the volunteer export when the form is switched off.
- **Each file stands alone.** Editing one audience's file never disturbs the other's open
  forms.
- **A translation mirrors pt-BR.** `src/web/content/<locale>/survey-<audience>.md` may
  change only the text: the same ids, in the same order, with the same types, required
  flags and max-lengths. A translated volunteer file with no pt-BR one fails the check.

### Review a change under the pseudo-locale

With `npm run dev` running, open the page with `?lang=en-XA`, or pick
"English (Pseudo-Accents)" in the footer. `?lang=pt-BR` switches back.

```text
http://localhost:3000/privacy?lang=en-XA
http://localhost:3000/privacy?lang=pt-BR
```

Everything from a catalog comes out accented, padded and bracketed:

```text
pt-BR   Privacidade
en-XA   [Ƥřīṽȧȧƈīḓȧȧḓḗḗ]
```

- **Plain, unaccented text** on the page (`Salvar`, say) is copy that escaped the
  catalogs.
- **Clipped text** is a layout that will not survive a longer language.
- **A `[` without its `]`** means two messages were joined in code.

Check with JavaScript both on and off; the server renders static text either way.

## 7. The guards

`npm run check` is the only gate: there is no CI yet, so run it before every commit.

| Step                   | Fails when                                                                          | Fix                                                        |
| ---------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `format:check`         | Prettier would reformat code (not `docs/`)                                          | `npx prettier --write <file>`                              |
| `lint`                 | Among other rules, an **accented** string or template literal in `src/web/client` or `src/modules/admin` | Move the text to a catalog              |
| `typecheck`            | An unknown accessor, a wrong argument, or a label map missing a key                 | Fix the call, or add the message or map entry              |
| `i18n:check`           | Generated output is stale; invalid ICU; an empty description; a translation with different arguments or an unknown ID; a missing message in a published locale; the pseudo-locale or a draft offered in production; a template calling `copy.x()` without a header, or a message its namespaces lack; an unknown `chrome.x()` / `shell.x()`; two header namespaces sharing an accessor | Usually `npm run i18n:build`; otherwise fix what it names |
| `i18n:inventory:check` | `docs/development/copy-inventory.md` differs from what the catalogs produce                     | `npm run i18n:inventory`                                   |
| `i18n:audit`           | Client code writes a literal containing a letter to a text sink: `textContent`, `innerText`, `innerHTML`, `placeholder`, `ariaLabel`, `title`, `alt`, `setAttribute` for those attributes, `confirm`, `alert`, toasts or hints | Read the text from a catalog |
| `survey:check`         | A questionnaire file breaks the grammar; the pt-BR participant file is missing; a translation's structure differs from pt-BR's; a translated volunteer file has no pt-BR one | Fix what it names; see [Edit the questionnaire](#edit-the-questionnaire) |

What a failure looks like, one line from each guard (all real output):

```text
# lint
  29:18  error  Read user-facing text from a message catalog; see docs/development/copy-management.md  no-restricted-syntax

# i18n:check
i18n: views/pages/error.ejs: chrome has no message "nope"
i18n: run `npm run i18n:build` after fixing the catalogs; see docs/development/copy-management.md

# i18n:inventory:check
i18n: docs/development/copy-inventory.md is stale; run `npm run i18n:inventory` (see docs/development/copy-management.md)

# i18n:audit
copy: src/web/client/modules/ui/clock.ts:33  .textContent  "Salvar"
copy: read the text from a message catalog, or mark a deliberate literal with /* copy-ok: <reason> */; see docs/development/copy-management.md

# survey:check
survey: src/web/content/pt-BR/survey-participant.md: "## Como você avalia a programação?": "max-length" applies only to text questions
survey: see "Edit the questionnaire" in docs/development/copy-management.md
```

The audit catches a literal however it reaches the sink, whether directly, through a
ternary or through `+`:

```ts
el.textContent = 'Salvar'; // flagged
toast.info(`Envio ${x} ok`); // flagged: the static parts have letters
button.setAttribute('aria-label', open ? 'Abrir' : label); // flagged: 'Abrir'
input.placeholder = 'Nome: ' + x; // flagged
el.textContent = `#${String(n)}`; // passes: no letters outside the placeholder
el.textContent = copy.bandRetry(); // passes
```

**Escape hatches, each with a reason:**

- `/* copy-ok: <reason> */` before a sink statement, for literals that are not copy. The
  four icon-ligature writes use it. A marker without a reason is itself a violation.
- `// eslint-disable-next-line no-restricted-syntax -- <reason>` for a legitimately
  accented literal.

```ts
/* copy-ok: icon ligature */
icon.textContent = 'refresh';

// eslint-disable-next-line no-restricted-syntax -- a folding table, never shown
const ACCENTED = 'áàâãäçéèêë';
```

**What the guards do not see:**

- **The audit is syntactic.** A literal that reaches a sink through a variable or a
  default parameter passes; the lint rule catches it only if it is accented.
- **The lint rule is pt-BR-specific.** "Buscar" has no accent.
- **EJS text is not audited.** Templates are guarded by the header and accessor checks,
  and new inline text shows up in the inventory's "Not yet migrated" counts, which a
  reviewer sees.
- **Nothing checks that a route's `getCopy` list matches the template header.**

## 8. Build and development workflow

- **`npm run dev`** runs `i18n:build` once, then watches `src/i18n/messages` and rebuilds
  on every save, alongside the client bundler and the server.
- **`npm run build` does not regenerate catalogs.** The FormatJS CLI is a native binary,
  and the container's musl build differs from a developer's glibc one, so the generated
  output is produced locally and committed. The server runs `.ts` directly and needs it
  at boot.
- **Generated files are erasable TypeScript only,** as the rest of the backend is (see
  `typescript-conventions.md`).
- **After any catalog change:** run `npm run i18n:build && npm run i18n:inventory`, then
  commit the catalog, `src/i18n/generated/` and `docs/development/copy-inventory.md` together.
- **Dependency pins:** `@formatjs/cli`, `@formatjs/icu-messageformat-parser`,
  `intl-messageformat` and `@formatjs/intl-localematcher` are pinned to exact versions.
  Upgrade them together, rebuild, and read the diff of `src/i18n/generated/`.

## 9. Reviewing and translating in Tolgee

The translation management system (TMS) is **Tolgee**. Its project holds pt-BR as the
base language, in one keyspace (no namespaces). Two rounds go through it: reviewing the
pt-BR wording ([9.1](#91-reviewing-pt-br-wording)) and adding a locale
([9.2](#92-adding-a-locale)). Only translatable namespaces take part.

**Into Tolgee, for either round.** `npm run i18n:export -- --format xliff` writes
`.ignore/i18n-export/<ns>.xliff` (`--out` changes the directory): XLIFF 1.2, with the
pt-BR text as `<source>` and the description as `<note>`, since Tolgee's JSON import drops
descriptions. Upload every file, with "override key descriptions" on if the keys already
exist. **Upload again before every round**, so Tolgee's pt-BR matches the repo.

**Out of Tolgee.** Always flat JSON (structure delimiter empty, ICU message format), one
language per export. Which command reads it depends on the language:

| Exported language | Command                                            | Writes                                                    |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------- |
| pt-BR             | `i18n:import-source <dir>`                         | `messages/pt-BR/<ns>.json`: the wording of existing IDs only |
| Any other         | `i18n:import --locale <tag> --format simple <dir>` | `messages/<tag>/<ns>.json`, each replaced outright        |

### 9.1 Reviewing pt-BR wording

1. **Upload** the current source, as above.
2. **Review.** The reviewer edits the pt-BR text in Tolgee;
   [For the copy reviewer](#10-for-the-copy-reviewer) is their side.
3. **Export** pt-BR from Tolgee as flat JSON and unzip it into `.ignore/tolgee-pt-BR/`.
4. **Import.** `npm run i18n:import-source -- .ignore/tolgee-pt-BR`.
   - **It reads** every `.json` under the directory, whatever the layout; each ID is
     placed in its namespace through the pt-BR catalogs.
   - **It changes** only `defaultMessage`. Descriptions and key order stay as they are,
     and a message that differs only in escaping (`'` against `''`) is left alone.
   - **It refuses, before writing anything,** an unknown ID, an empty or invalid message,
     a tag, and a message whose arguments differ from the catalog's, including a select
     that gains or loses a case. Such a change alters the accessor: edit the message and
     its call sites by hand.
   - **It warns** about each catalog ID the export lacks, and leaves it unchanged.
   - **It rebuilds.** If the build fails, every file is put back as it was.
5. **Read the diff.** `git diff src/i18n/messages/pt-BR` should hold only the reviewer's
   edits. A hunk that undoes a recent change in the repo means Tolgee's pt-BR was stale:
   revert the hunk and upload again.
6. **Commit** as in [§8](#8-build-and-development-workflow): `npm run i18n:inventory`,
   then the catalogs, `src/i18n/generated/` and `docs/development/copy-inventory.md` together.

A real run with one edit, then one with `{checkinNumber}` renamed in `raffle.resetLabel`:

```text
i18n: pt-BR/raffle.json: raffle.idle
i18n: wrote 52 files
```

```text
i18n: pt-BR/raffle: raffle.resetLabel: arguments differ from the catalog's; change the message and its call sites by hand
i18n: pt-BR left unchanged
```

### 9.2 Adding a locale

1. **Register the locale as a draft.** Add the tag to `LOCALES` and to `DRAFT_LOCALES` in
   `src/i18n/locales.ts`. A draft renders in development and is never offered in
   production.
2. **Export and translate.** Upload the XLIFF files as above and translate in Tolgee.
3. **Import.** Export the language from Tolgee as flat JSON, then
   `npm run i18n:import -- --locale <tag> --format simple <dir>`.
   - **It needs one `<dir>/<ns>.json` per namespace.** A one-keyspace Tolgee project
     exports a single file per language, so this step is blocked until that changes.
   - **It refuses, before writing anything,** the base or pseudo locale, a locale not in
     `LOCALES`, a file for an unknown or untranslatable namespace, an ID the source does
     not have, and invalid ICU.
   - **It writes** `src/i18n/messages/<tag>/<ns>.json` in the source's shape, with the
     pt-BR descriptions. Empty strings are dropped.
   - **It rebuilds.** If the build rejects a translation (typically a renamed or retyped
     argument), every file is put back as it was.
   - **Re-import after every Tolgee round.** Each file is replaced outright; never edit
     one by hand.
4. **Review** in development with the footer switcher or `?lang=<tag>`. An untranslated
   message is served in pt-BR, and the build lists each one as a warning.
5. **Publish.** Remove the tag from `DRAFT_LOCALES`. From then on a missing message is a
   build error, so `npm run check` passes only for a complete locale.
6. **Legal.** pt-BR remains authoritative. Add
   `src/web/content/<tag>/{privacy-notice,terms-of-use}.md` only once a translation is
   signed off; until then the pt-BR notices are served.
7. **WhatsApp.** Get the template approved by Meta in the new language, add it to
   `WHATSAPP_TEMPLATES` under `name:language`, and add the locale's code to
   `META_LANGUAGE`.

The whole round, for a hypothetical Spanish locale:

```ts
// src/i18n/locales.ts
export const LOCALES = ['pt-BR', 'en-XA', 'es'] as const;
export const DRAFT_LOCALES: readonly Locale[] = ['es'];
```

```bash
npm run i18n:export -- --format xliff              # → .ignore/i18n-export/*.xliff
# … upload to Tolgee, translate, export es as flat JSON into ./es-from-tolgee/<ns>.json
npm run i18n:import -- --locale es --format simple ./es-from-tolgee
npm run check                                      # warnings list what is untranslated
# once complete: remove 'es' from DRAFT_LOCALES, and npm run check must pass
```

One exported entry, as Tolgee receives it in `raffle.xliff`:

```xml
<trans-unit id="raffle.resetLabel">
  <source>Devolver #{checkinNumber, number, ::group-off} aos restantes</source>
  <note>Accessible name of the control that puts a drawn number back into the pool. …</note>
</trans-unit>
```

And what `i18n:import` writes back to `src/i18n/messages/es/raffle.json`: the source's
shape, with the pt-BR description, whatever the TMS returned:

```json
"raffle.resetLabel": {
  "defaultMessage": "Devolver el #{checkinNumber, number, ::group-off} a los restantes",
  "description": "Accessible name of the control that puts a drawn number back into the pool. …"
}
```

A translation that renames an argument is rejected, and the previous files are put
back. This is a real run, with `{audience}` renamed in `checkin.ticket.defaultHint`:

```text
i18n: es/checkin: checkin.ticket.defaultHint: Missing variable audience in message
i18n: es left unchanged
```

**Another TMS.** `--format` also takes `default`, `simple`, `transifex`, `lokalise` and
`crowdin`, which `i18n:export` writes and `i18n:import` reads; `xliff` is export-only.

## 10. For the copy reviewer

You do not need to read code. Everything the app says to attendees and staff is in one
document, [`copy-inventory.md`](./copy-inventory.md), which is regenerated from the source
whenever the text changes, so it is always current.

**Reading it.** It is grouped by area of the app (check-in, pass, staff, raffle, …). Each
message looks like this:

```md
### staff · band · retry

> Atualizar

- **Why:** Replaces the band word when it stops refreshing. …
- **Ref:** `staff.band.retry`
- **Locales:** pt-BR ✓ · en-XA (pseudo)
```

- **The quote** is the exact text shown. Parts in braces are filled in by the app:
  `{name}` is a name, and `{n, plural, =1 {…} other {…}}` gives the wording for one and
  for many.
- **Why** explains where the text appears and what it must get across. Please keep that
  intent, or say that you want to change it.
- **Ref** is the message's name; quote it when you propose a change.
- Sections whose name starts with `admin-` are the staff screens.

**Proposing changes.** One per line, the Ref followed by the new text:

```
staff.band.retry → Recarregar
raffle.idle → Toque em gerar para começar
```

A developer applies them exactly. If a sentence should change for one audience only
(participants or volunteers), say which.

**Reviewing in Tolgee** instead of the list works too. A developer brings your edits back
([9.1](#91-reviewing-pt-br-wording)), so:

- Edit only the pt-BR text, and leave the parts in braces as they are.
- Do not add, delete or rename keys.
- Changes to a key's description (the **Why**) do not come back. Propose those in the list
  above.

**The appendices at the end:**

- **A. Duplicates:** the same text used in several places. Say whether they should stay
  the same.
- **B. Plural and select:** messages that change with a number or an audience.
- **C. Longest message per screen:** the text most likely to crowd a phone screen.
- **D. Not yet migrated:** counts of text still written directly in code. What is left
  is brand names, technical labels (p50, p95) and codes, not wording to review.
- **E. WhatsApp templates:** the message bodies are approved by Meta and changed in
  WhatsApp Manager, not here. The appendix lists each template's audiences and variables.
- Staff-screen error messages are ordinary messages now, under `admin-errors`.

The privacy notice and the terms of use are edited by their owner, not through this
document.

## 11. History

The records below are in the private archive repository, not in this one.

- `git show d0aa585:docs/copy-management-plan.md`: the design record. Why ICU catalogs and
  FormatJS, the alternatives rejected, the risks, and the phase plan.
- `git show d0aa585:docs/copy-management-checklist.md`: the build log. Phases 0–8, what each
  verified, and what was found along the way. Items still open moved to
  `todo.md` §6, since closed (`git show 5f0d61a:docs/todo.md`).
