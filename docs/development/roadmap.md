# Roadmap

Event branding and content move from `.env` and the code into per-event settings, stored in the
database and edited in `/admin`. A new event becomes configuration rather than a fork.

Built one `feature/*` branch per item, in this order. Item 1 comes first because items 2, 3 and 4
depend on it; item 5 is independent and fits anywhere.

## 1. Event setup in `/admin`

Move event content out of `.env` and the code into per-event settings, edited in a new
`/admin/setup` page.

Legal fields are the exception to the defaults: the organiser's legal name, CNPJ, contact and site
have no default, because a placeholder legal identity would read as a real one. In 2.0.0 the
operator edits the Markdown templates in `src/web/content/pt-BR/` and removes the template banner;
once settings exist, the banner shows while any legal field is unset.

| Moves to settings                                                                      | Stays in `.env`                                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Event start, close and time zone; check-in opening offsets                             | Secrets: pass, admin pepper, Turnstile, WhatsApp token and app secret |
| Survey windows, enablement, questions and options                                      | Postgres, Redis, Cloudflare Access, tunnel, Tailscale                 |
| Item redemption options (`docs/features/redemption-options.md`)                        | Rate limits, load shedding, alerting, logging, telemetry              |
| WhatsApp template list, door templates, default country code, budget                   | `EVENT_ID`, `APP_URL`, `SITE_HOST`                                    |
| Copy placeholders (defaults in `COPY_DEFAULTS`, `src/constants/copy-defaults.ts`): event name, with a PelicanPass default; legal name, CNPJ, contact and site, with no default |                                                                       |
| Organisation details; its full privacy policy, which the `/privacy` notice references  |                                                                       |
| The editable parts of `/privacy` and `/terms`; other event- or organisation-specific copy |                                                                    |
| `APP_TITLE`, landing and pass welcome toggles                                          |                                                                       |

Approach:

- A settings table keyed by `EVENT_ID` (scoping exists since migration 006), one typed schema per
  group, validated with the same rules `src/config/env.ts` applies today. The shipped defaults
  (`COPY_DEFAULTS`, the content files in `src/web/content/pt-BR/`, and the PelicanPass assets) are
  the seed.
- During migration, read the setting and fall back to the env var, with a startup notice
  (`src/config/startup-notices.ts`) when the env var is still set. Remove the env vars in the next
  major version.
- Settings are read on hot paths (check-in, pass): cache them in process and in Redis, invalidated
  on save; never a query per request.
- New admin scope `setup`, and every save logged to `app_events` with the actor.
- Override only named strings at runtime (title, wordmark alt, legal and survey content). The i18n
  catalogs compile at build time and stay out of settings; strings that name the event or the
  organisation take them as interpolation parameters filled from settings.
- Legal content is Markdown rendered with `renderMarkdown` (`src/shared/utils/markdown.ts`), as
  `src/web/content/notices.ts` does today. That module parses the files once at boot; settings
  move rendering to save time, cached with the rest. The organisation's full privacy policy, which
  the app does not ship, gets its own route, and the privacy notice links to it.
- **Risk: survey versioning.** Answers must stay tied to the questions they answered. Version the
  question set, store the version with each response, and lock editing of a version once it has
  responses. `parseSurvey` fills `{eventName}` before the labels are hashed, so renaming the
  event would change the version: fill after hashing, or hash the unfilled source.

Done when: an event can be set up from an empty database through `/admin/setup` without editing
code or the listed env vars, `/terms` and `/privacy` show the template banner until the legal fields
are set, and `npm run check` passes.

## 2. Branding customisation

Builds on item 1's store.

- Colours: the operator picks the main colours; settings write the CSS custom properties in
  `css/base/variables.css` as an inline style block in the layouts (nonce-covered by the CSP).
  Check contrast on save (WCAG AA against the background tokens).
- Icons and wordmarks: upload in `/admin/setup`, validated for format and the pixel sizes in
  [`docs/design/brand.md`](../design/brand.md); the maskable icon's safe zone is the operator's
  responsibility, shown as a preview. Serve them from a versioned URL so the asset cache rules still
  apply (`docs/infrastructure/asset-delivery.md`).
- `/site.webmanifest`, the favicon links and the boot screen read from settings, falling back to the
  default PelicanPass assets.

Done when: a previous event's brand can be recreated from its assets through `/admin` alone.

## 3. `/admin/whatsapp`: templates, run history, reset

- **Template management**: CRUD over the templates moved by item 1, replacing
  `src/constants/whatsapp-templates.ts`. Optionally sync names and status from the WhatsApp Business
  Management API.
- **Run history**: list past sends grouped by run (template, audience, started by, counts by
  status, cost), built on the run and per-recipient tables of migration 018, which already group
  sends by `run_id`.
- **Reset**: define it before building: re-queue failed sends, clear a run's state so it can be
  sent again, or both. Require confirmation and log it to `app_events`.

## 4. Country code column

- Migration adding a country code column to attendees, back-filled by splitting stored numbers
  with the logic in `src/modules/whatsapp/whatsapp.phone.ts`, defaulting to item 1's default country
  code. Report rows that cannot be split rather than guessing.
- Update the attendee form, the CSV import (`docs/operations/imports.md`) and export, and the
  WhatsApp send path to build E.164 from the two columns.

## 5. Persistent roster filters

When leaving a record form, return to the roster with the filters it was opened from.

- Keep filters in the roster's query string, pass it to the record links as a `return` parameter,
  and redirect back to it after save or cancel. Validate it as a same-origin roster path to avoid an
  open redirect.
- No session storage: the URL survives reloads and can be shared between staff.

## Other planned work

Planned independently of the items above, each in its own document:

- [`admin-export-plan.md`](./admin-export-plan.md): result exports in `/admin/exports`, with an anonymous variant for the CLI export too
- [`admin-import-plan.md`](./admin-import-plan.md): the roster and volunteer-permission CSV imports in `/admin/import`, with a preview before commit
- [`qr-scanner-speed-plan.md`](./qr-scanner-speed-plan.md): a faster QR scanner on slow phones, replacing html5-qrcode with the native detector and a WebAssembly fallback
