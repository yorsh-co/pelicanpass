# Post-Event Report

How to turn the results export and the questionnaire answers into an interactive report: what goes in,
the two ways to produce it, what each tab shows, how every figure is defined, and what the output
carries.

Written for whoever runs the event and was not here while it was built.

Companion documents:

- [`deployment.md`](./deployment.md#teardown): the commands that produce the input files
- [`data-retention.md`](../security/data-retention.md): what may outlive the host, and why the
  questionnaire export is anonymous
- [`survey.md`](../features/survey.md): how the questionnaire and its answers work

The report UI is in Portuguese (pt-BR); this document is not.

---

## What this is

`npm run report` builds one page from the files taken off the host at teardown. It has seven tabs
(Visão geral, Vendas, Check-in, Perfil, Retiradas, Questionário, Comentários), and four filters that apply
across them: audience, church, ticket type and age. Charts are ECharts, themed to match the app. It follows
the system light or dark setting until the toggle beside the title is used; that choice is then
remembered in the browser. **Apresentar** turns the same data into a 16:9 slide deck for the debrief.

It reads files only. It never connects to the database and needs no running stack.

## Inputs

| File                   | Produced by                                         | Required |
| ---------------------- | --------------------------------------------------- | -------- |
| Check-in results CSV   | `scripts/db/export-results.sql`                     | Yes      |
| Participant survey CSV | `scripts/survey/export-csv.ts --audience participant` | No     |
| Volunteer survey CSV   | `scripts/survey/export-csv.ts --audience volunteer`   | No     |
| Feedback summary (`.md`) | Written by hand, see [Writing the resumo](#writing-the-resumo) | No |

The commands for the first three are in [`deployment.md`](./deployment.md#teardown). Run them before
the host goes away; nothing here can recover a file that was not exported.

Without the survey files the check-in, redemption and Perfil tabs still work.

### The `church` column

The church of each attendee is not in the database. The Igrejas section of the Perfil tab and the
church filter exist only if the check-in CSV has a `church` column. Add it by hand, from the organiser's roster, before
feeding the file to the report:

1. Open `checkin-results.csv` in a spreadsheet and match each row to the roster by `ticket_code`.
2. Add a column headed `church` and fill in the church name. Spell each church the same way on every
   row: the chart and table group by exact text after trimming, while the Igrejas filter and the host church comparison match ignoring case and extra spaces.
3. Save as CSV UTF-8.

Empty cells count as "no church". Without the column, the section and filter are absent.

### The `age` column

Age is not in the database either. The Faixa etária section of the Perfil tab and the Idade filter
exist only if the check-in CSV has an `age` column. Add it by hand, from the organiser's roster, the
same way as `church`:

1. Open `checkin-results.csv` in a spreadsheet and match each row to the roster by `ticket_code`.
2. Add a column headed `age` and fill in each person's age in whole years.
3. Save as CSV UTF-8.

Accepted values are whole numbers from 0 to 120. Anything else (a decimal, text, a negative number or
more than 120) stops the build with a message naming the column and line, so a typo is never counted
silently. Empty cells are allowed and count as _Não informada_. Volunteers' ages are ignored.

The exact age is mostly discarded as the file is read. Ages 13 to 18 are kept as single years; ages
12 or less (≤12) and 19 or more (19+) are collapsed, so neither output contains those ages. Without the
column, the section and filter are absent.

### The `sale_date` column

The Vendas tab and slide exist only if the check-in CSV has a `sale_date` column holding the date each
ticket was sold. Accepted values are `YYYY-MM-DD` or `DD/MM/YYYY`, optionally followed by a space or
`T` and a time; the time is ignored. Empty cells are allowed and are counted under _Sem data_. Anything
else (or a date that does not exist, such as 31/02/2026) stops the build with a message naming the
column and line. Volunteers' sale dates are ignored. Without the column, or when no participant has a
date, the tab and slide are absent.

### Keep `ticket_code`

Leave the `ticket_code` column in the CSV. The report uses it for one thing: codes whose key is `d`
(the walk-in range, see [Generating ticket codes](./imports.md#generating-ticket-codes)) are counted
as _comprado no dia_ (bought on the day). It is dropped as the file is read; neither output contains
it.

Without the column the walk-in figure shows "—" and the Ingresso (ticket-type) filter is hidden.
Everything else is unaffected.

---

## Producing the report

Two ways, from one source. Both run from the repo root on any machine with Node and `npm ci` done.

### Template, for an artifact

```bash
npm run report -- --template [--host-church "Igreja Exemplo A"] --out template.html
```

This writes an HTML fragment with no data in it, to publish as a claude.ai Artifact. The organiser
opens the artifact and drops the CSVs on it. The files are parsed in the browser and are not
uploaded. The `.md` summary is not read in this mode.

Publish the artifact privately and share its link only with organisers. Do not put the link in the
repository.

### Data, for a standalone file

```bash
npm run report -- \
  --checkin checkin-results.csv \
  --survey-participant survey-participant.csv \
  --survey-volunteer survey-volunteer.csv \
  --resumo resumo.md \
  --host-church "Igreja Exemplo A" \
  --out reports/relatorio.html
```

Only `--checkin` is required; `--host-church` is optional. `--out` defaults to `reports/relatorio.html`. The parsed model is
embedded in the page, not the raw CSV. A malformed input stops the build with a message naming the
column and line.

`--host-church <nome>` names the church that hosts the event, as written in the `church` column. It
turns on the comparison of the host church against the others (see below), and it is also accepted
with `--template`. The sample data of the template uses `Igreja Exemplo A` as its host church.

Open the file in a browser. The charts load ECharts 6.1.0 from jsDelivr, so viewing needs an internet
connection.

---

## The tabs

| Tab          | Shows                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------ |
| Visão geral  | Headline figures: tickets (with walk-ins), check-ins, absentees and no-show rate, volunteers present, questionnaire response, mean overall score, and check-ins every 5 minutes, one chart per audience |
| Vendas       | Participant tickets by sale date, as KPI tiles (tickets with a sale date, sold in the last week, sold on the day) and a bar chart, oldest to newest, that gets finer as the event nears. Periods are anchored on the event day (the day of the first participant check-in, else the latest sale date): over 6 months, 3–6, 2–3 and 1–2 months before it, then three 7-day weeks, then the last week before the event as a single bar, then the event day. "1–2 meses" ends where the weekly bars begin. Later sales count on the event day, and tickets without a date form a muted _Sem data_ bar. The date comes from `sale_date`; the ticket code prefix is not used. Follows the filters, but the periods do not move with them. Only present when the CSV has `sale_date`. Every bar is labelled as a countdown to the event ("1–2 meses", "2–3 semanas", "0–1 semana", "Dia do evento"); hover a bar or open the table for its exact dates |
| Check-in     | Check-ins per interval (5, 15, 30 or 60 minutes; 5 by default), the cumulative total, arrival milestones, and a breakdown by ticket type |
| Perfil       | Who attended, in two sections. **Igrejas**: attendance per church, with the host church against all other churches above it (only with `--host-church`); clicking a church bar or row toggles it in the church filter everywhere; only present when the CSV has `church`. **Faixa etária**: participants per age group (≤12, 13, 14, 15, 16, 17, 18 and 19+), including _Não informada_; the filter keeps three ranges, so clicking a bar or a row toggles that group's range (13 to 18 for any single year) in the age filter, which holds several ranges at once; only present when the CSV has `age`. Old `#igrejas` links still open this tab |
| Retiradas    | Per item and role: redeemed against entitled, redemptions per interval (same choice as Check-in) with their running total, options ordered against redeemed. The item chosen is remembered in the browser and also picks the item on the _Retiradas por horário_ slide. Each card leads with how long redemption took (first to last redemption; a dash for a single one), then the window, redeemed against entitled and the rate. Items nobody collected, such as T-shirts handed out on the day, are hidden |
| Questionário | Scores, rankings and distributions per audience (participant ratings ranked in three cards: Atrações, Estrutura do evento and, only when a question is unmapped, Outras avaliações); volunteer results per area; answers that matched no area |
| Comentários  | Free-text answers, searchable, by audience and question; `volunteer_area`, when present, is excluded. A follow-up question is shown with the question it explains ("question → follow-up") in the selector and in each comment's footer, which leads with that respondent's answer to the parent ("Nota 4", "Sim", "Não"; left out if unanswered) |

### Which filters apply where

The report opens with Público set to **Participantes**, every age and the staff church (_Convidado_)
excluded; _Limpar filtros_ returns to that. Choosing _Todos_ brings volunteers into the
views.

| Filter        | Check-in data (Visão geral, Check-in, Retiradas, Perfil) | Questionnaire (Questionário, Comentários) |
| ------------- | --------------------------------------------------------- | ------------------------------------------ |
| Público (audience) | Yes                                                  | Yes                                        |
| Igreja        | Yes                                                       | No                                         |
| Ingresso (ticket) | Yes                                                   | No                                         |
| Idade (age)   | Yes                                                       | No                                         |

Ingresso and Idade describe participants only, so setting either removes volunteers from the check-in
data views, and the page says so. Igreja never hides volunteers, who have no church. The Perfil tab
keeps listing every church and every age band while one is excluded or unselected, dimming it, so it
can be brought back.

Igreja is a checkbox dropdown beside Público, labelled **Igrejas**. Each church in the data has a
checkbox, checked while included, and changes apply at once. **Todas** and **Nenhuma** at the top
include or exclude every church, and **Restaurar padrão** returns to the default. The button reads
"Todas", "Todas exceto Convidado", "Todas exceto N" (several excluded), the church name or
"2 igrejas" (one or two included) or "Nenhuma". Esc, or a click outside, closes the panel. The filter
is stored as the churches left out, so a church that appears in a later file is included without any
change. Clicking a church bar or row on the Perfil tab toggles that church; excluded rows are muted and
marked "excluída".

_Convidado_ (staff invites, which the export lists as participants) is excluded by default,
matched ignoring case and extra spaces, so staff are out of the tickets and attendance figures until
the checkbox is ticked. **Restaurar padrão** and **Limpar filtros** return to that.

Idade is a row of toggle chips, one per band (≤12, 13–18, 19+), plus **N/I** (_Não informada_) when
some participant has no age. Click chips to select several bands; none selected means every age. Clicking
a bar or a row on the Perfil tab toggles the same bands. The footer and filter summary list the selected
bands, for example "Idade: ≤12, 19+". **Limpar filtros** clears the chips.

The questionnaire is anonymous: an answer carries no attendee, so it cannot be attributed to a church
or a ticket type. Both questionnaire tabs ignore these three filters, and the Questionário tab says so
when any differs from the default. For the same reason, survey answers can include staff invites.

---

## Presenting

**Apresentar**, beside the title, replaces the page with a slide deck of the same data. It works in
the template (after loading the files) and in the standalone file. Slides are drawn on a fixed
1920×1080 canvas and scaled to the screen, with bars where the aspect ratio differs, so it looks the
same on a laptop and on a projector.

### The host church against the other churches

The Igrejas section of the Perfil tab, and the Igrejas slide, compare the host church, named with `--host-church`, with every other church: tickets, check-ins and
no-show rate for each. Without that option the comparison is not shown. Only participants count, matched on the `church` column ignoring case and
extra spaces. The chart groups names exactly, so spell it the same on every row. Participants with no church are left out of both sides and reported in a note. The
comparison follows the church selection: excluded churches are in neither side, so with the default
the staff are not counted under "Outras igrejas". It is hidden when no participant belongs to the host
church.

### The slides

A slide is shown only when it has something to say; the deck adjusts to the data and the filters.

| Slide                | Shown when                                                                          |
| -------------------- | ----------------------------------------------------------------------------------- |
| Capa (event name)    | Always                                                                              |
| Presença             | Participants are included and there are tickets                                     |
| Vendas de ingressos  | Participants are included and some participant has a sale date. Same bars as the tab, with the last-week and event-day totals under the title. Decided on unfiltered data, so it stays while filters are active |
| Check-in             | Anyone in view has a check-in time                                                  |
| Igrejas              | Participants are included and the CSV has `church`; kept while churches are excluded, dimming them. The host church comparison sits beside the chart, with `--host-church` |
| Participantes por idade | Participants are included and some participant has an age. Shows the same groups as the chart. Decided on unfiltered data, so it stays while an age is selected, highlighting the selected bands |
| Retiradas            | At least one item has been redeemed in view; items nobody collected are left out    |
| Retiradas por horário | Same as Retiradas. Redemptions every 5 minutes, stacked by role, beside the running total, for the item chosen on the Retiradas tab (the first redeemed item when that one has none in view) |
| Nota geral           | The participant survey has overall-score answers                                    |
| Voltariam e convidariam | The participant survey has yes/no answers                                           |
| Avaliação das atrações | The participant survey has answers to attraction questions (programme) |
| Estrutura do evento  | The participant survey has answers to event-structure questions (check-in, food, venue and facilities, communication). Unmapped questions are not in the deck |
| Voluntários          | Volunteers are included and present, or the volunteer survey has answers            |
| Voluntários por área | The volunteer survey has answers that matched an area                               |
| Resumo               | A `--resumo` file was given (data mode only)                                        |
| Obrigado             | Always; carries the credit line "Produzido por Josh Porter"                         |

Participant rating questions are grouped in `scripts/report/core/rating-groups.ts`. Add a new rating
question to `RATING_GROUPS` there; the test in `rating-groups.test.ts` fails while a rating question of
`survey-participant.md` (other than `overall_rating`) is unmapped.

Follow-up text questions are linked to their parent in `scripts/report/core/survey.ts`. Name a new one
`<id>_comment` after the question `<id>` it explains, or add it to `FOLLOW_UPS` when the name does not
fit; the test in `survey.test.ts` fails when a volunteer follow-up (other than `comments`) loses its parent.

The deck follows the active filters and lists them in the footer, for example
`Filtros: Participantes · Igrejas: Igreja Exemplo A`. Churches appear in the footer only when the
selection differs from the default. As in the tabs, the survey slides ignore the church, ticket and
age filters, and carry a note saying the questionnaire is anonymous when any differs from the default.

### Choosing slides

**Apresentar** first opens the **Escolher slides** dialog. It lists every slide available under the
current filters, in deck order, each with a checkbox, all checked at first. The resumo is a single
entry however many slides it spans. **Todos** and **Nenhum** check or uncheck the whole list, and
**Começar apresentação** is disabled while nothing is checked. **Cancelar** or Esc closes the dialog
without starting.

Unchecked slides are remembered per browser, as exclusions rather than inclusions, so a slide that
becomes available later (for example after loading new data) starts included. If the remembered
exclusions would leave nothing to show, the deck falls back to every available slide.

During the presentation, the **Slides** button reopens the dialog; **Aplicar** rebuilds the deck and
stays on the current slide, or moves to the next selected one if it was removed. Esc closes only the
dialog, and the arrow keys do nothing while it is open.

The counter, Home and End, and `#apresentacao-N` count only the selected slides, so the same link
opens a different slide after the selection changes. A link opened directly skips the dialog and uses
the remembered selection.

### Controls

| Action              | Keys or click                                      |
| ------------------- | -------------------------------------------------- |
| Next slide          | Right arrow, Page Down, Space, Enter, click on the right two thirds |
| Previous slide      | Left arrow, Page Up, Backspace, click on the left third |
| First, last slide   | Home, End                                          |
| Fullscreen          | F                                                  |
| Light or dark theme | T (stays on the same slide)                        |
| Choose slides       | **Slides** button                                  |
| Exit                | Esc                                                |

Page Up and Page Down are what most presentation clickers send. The on-screen controls fade after two
seconds without pointer movement and return when it moves. Each slide has a link, `#apresentacao-N`,
that opens the deck at that slide.

### The resumo slides

The summary is paginated automatically: its sections are measured and spread over as many slides as
they need. A single block taller than a slide, such as a very long list, is clipped, so keep each
section of the resumo short. Feedback reaches the deck only through the reviewed resumo; raw comments
are never shown.

---

## Metric definitions

- **Tickets** is the number of non-archived participants. **Archived rows** (registrations retired
  from the event) are excluded from every count and every chart, and are listed separately so the
  difference is visible.
- **No-show rate** is absent ÷ tickets: tickets whose holder never completed check-in.
- **Redemption rate** is redeemed ÷ entitled, per item and role. Entitled counts attendees who have a
  choice recorded for that item.
- **Redemption window** is the time from the first to the last redemption of an item, per item and
  role.
- **Response rate** is responses ÷ that audience's check-ins. Participants and volunteers are
  divided by their own check-ins.
- **Score bands** split a 1–10 rating into 9–10, 7–8 and ≤6.
- **Volunteer area results** are withheld for any area with fewer than 5 responses, so a small team's
  answers cannot be read back to individuals.

---

## Writing the resumo

The Comentários tab lists every free-text answer. For a readable overview, write a short Markdown
summary once, after reading them, and pass it with `--resumo`. It appears as _Resumo do feedback_ at
the top of the Questionário tab.

Write it in Portuguese, as headings and bullets: themes, how often they came up, and a few
representative quotes. Quote sparingly and never in a way that names someone. Because it is
rendered from Markdown at build time, write plain Markdown and no HTML. It is only supported in data
mode.

---

## Privacy and retention

- `ticket_code` is read only to derive walk-ins and is discarded. Neither output contains it.
- The template contains no data. Data is parsed in the browser and not uploaded.
- The data-mode file contains the survey free text and the church, age group and sale date (no time) of every attendee row. Share it
  only with organisers, and never commit it. `reports/` is git-ignored and outside the Docker build
  context.
- `age` is read only to derive its group. Ages 13 to 18 are kept as single years by design; ≤12 and 19+
  are collapsed and the exact age is discarded. Single-year ages for 13 to 18 together with church on
  each row make the data-mode file more identifying, so keep it organiser-only.
- The check-in CSV is pseudonymous and the survey CSVs are anonymous; see
  [`data-retention.md`](../security/data-retention.md) for what may be kept and for how long. Adding
  `church`, `age` or `sale_date` is what makes the check-in file more identifying: the report inherits the
  retention of whatever you feed it.

---

## Extending the area aliases

Where a volunteer questionnaire asks for the volunteer's area as free text with the id `volunteer_area`, the answers are matched here. The bundled questionnaire has no such question, so the area breakdown stays hidden until one is added. Each answer is matched to the 16
canonical areas, plus a short alias list, in `scripts/report/core/areas.ts`. Answers that match
nothing are listed under _Respostas sem área identificada_ at the bottom of the volunteer section.

To fold one into an area, add it to `ALIASES`, keyed by normalised text (uppercase, no accents,
punctuation as single spaces):

```ts
const ALIASES = {
  // …
  ARTE: 'ARTES',
};
```

Keep an alias to cases that name exactly one area and that no other area's name contains. Add a test
case in `scripts/report/core/areas.test.ts`, then rebuild.

---

## Development

Source is in `scripts/report/`: `core/` (parsing and metrics, no DOM), `page/` (browser code, bundled
with esbuild) and `build.ts`.

```bash
node --test 'scripts/report/**/*.test.ts'   # the report's tests
npm run typecheck:report                    # the browser code has its own tsconfig
npm test                                    # everything
```

In the template, **Ver com dados de exemplo** loads generated sample CSVs, so the page can be
checked without real data. The same generator backs the tests (`core/sample.ts`).
