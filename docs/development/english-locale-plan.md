# English Locale Plan

Adds English (`en`) as a published locale, in production and in the static demo, where visitors can
toggle between pt-BR and English. pt-BR stays the source locale and is authoritative for the legal
notices.

## Decisions

| Topic         | Decision                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Scope         | Published in production, not demo-only. `Accept-Language` may select it.                         |
| Locale tag    | `en`. The switcher labels it "English", region chip `US`.                                        |
| Legal notices | Translated, each opening with a note that the pt-BR version is authoritative.                   |
| Fixture data  | Unchanged (names, items, event). It is moving to the admin setup editor.                         |
| Demo routing  | Frontend only: an `/en/` tree plus a pre-paint redirect script. No Pages Function or Worker.     |
| Translation   | Drafted in the repo for review; no Tolgee round.                                                 |

## Phases

Each phase is one git-flow branch off `develop`, merged back with `--no-ff`. It ends with
`npm run check` passing, a `CHANGELOG.md` entry under Unreleased, and Conventional Commits.

### Phase 1: Register `en` and translate the attendee catalogs

Branch: `feature/i18n-en-attendee-catalogs`.

- Add `'en'` to `LOCALES` and `DRAFT_LOCALES` in `src/i18n/locales.ts`.
- Write the [glossary](#glossary) below, used by every later phase.
- Translate `chrome`, `landing`, `errors`, `checkin`, `pass`, `staff`, `raffle`, `qr` and `survey`
  through `npm run i18n:import -- --locale en --format simple <dir>`. Generated files come from the
  tool, never edited by hand.

### Phase 2: Translate the admin catalogs

Branch: `feature/i18n-en-admin-catalogs`.

- Translate every `admin-*` namespace the same way, following the glossary.
- The build reports no untranslated `en` message.

### Phase 3: Long-form content and publication

Branch: `feature/i18n-en-publish`.

- `src/web/content/en/`: `survey-participant.md`, `survey-volunteer.md`, `privacy-notice.md` and
  `terms-of-use.md`. The notices open with the authoritative-version note, linked to the pt-BR text.
- Confirm a locale without a `META_LANGUAGE` entry still sends the approved pt-BR WhatsApp template.
- Remove `'en'` from `DRAFT_LOCALES`. From here a missing message fails the build.

### Phase 4: Demo toggle

Branch: `feature/demo-locale-toggle`.

- `scripts/demo/build.ts` renders every page per locale: pt-BR at the current paths, English under
  `en/`, mirrored in `_redirects` (including the English 404).
- The footer and admin-nav switcher links point at the matching page in the other tree.
- Plain root-absolute links in English pages are rewritten to `/en/…`.
- The mock script, first in `<head>`, saves `?lang=` to `localStorage` and `location.replace()`s to
  the tree matching the saved choice, or `navigator.language` on a first visit. This catches the
  client's own root-absolute navigations.
- The banner is rendered in the page's language only; its language button links to the other tree.
  `banner-language.ts` and the dual-copy CSS go. Demo-only strings in `admin-guard.ts` gain English.
- **Constraint:** the CSP line in `_headers` is 1,634 characters and Cloudflare caps a header value at
  2,000. Inline hashes that differ per locale must not push it over; the build should fail if they do.
- `scripts/demo/build.test.ts` covers the English tree.

### Phase 5: Docs

Branch: `docs/english-locale`.

- `docs/operations/demo-site.md`, `docs/development/copy-management.md`, `README.md`.
- `npm run i18n:inventory`.

## Glossary

| pt-BR | English | Note |
| --- | --- | --- |
| check-in | check-in (noun, adjective), check in (verb) | The number an attendee gets is the "check-in number". |
| ingresso | ticket | Never "pass". |
| código do ingresso | ticket code | |
| código de checkin (voluntário) | check-in code | Volunteer variant of the ticket code. |
| cadastro (voluntário) | registration | What a volunteer looks up on the check-in screen. |
| participante | participant | Role: a person attending as a participant, as opposed to a volunteer. Addressed as "you". |
| pessoa | attendee | Umbrella for participants and volunteers, as in `AttendeeRole`. Never use it for participants alone. |
| voluntário | volunteer | Tier chips: Register, Numbers, Lookup, T-shirts, Pickups. |
| staff, equipe | staff | A volunteer at a station is "staff". |
| mesa de suporte | support desk | |
| estação | station | A staff post that serves certain items. |
| verificação (captcha) | verification | The bot challenge. "Security check" only for the expired state. |
| identidade | identity | Second check-in step: confirming the code is the person's own. |
| presença | arrival | Third check-in step. "Confirm your arrival." |
| QR Code | QR code | Lower-case "code". |
| apelido | nickname | Shown on screen as "how your name appears". |
| chapelaria | cloakroom | |
| retirada, retirar | pickup, collect | Verb for an attendee is "collect"; the staff screen is "Pickups". |
| resgate | redemption | Admin term; the attendee-facing copy says pickup. |
| gerador de números | raffle, number generator | Draw: "generate a number". "Drawn" for the list. |
| interações | raffle | Label beside the check-in number. |
| devolver (aos restantes) | return to the pool | |
| camiseta | T-shirt | |
| palavra chave | keyword | The rotating word on a volunteer pass. |
| questionário, feedback | survey, feedback | "Survey" for the form, "feedback" for the invitation. |
| painel admin | admin panel | |
| Entrar, Sair | Sign in, Sign out | |
