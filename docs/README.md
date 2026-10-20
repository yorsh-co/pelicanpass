# Documentation

The folders are grouped by what you are doing: running the event, setting up the hosts, measuring capacity, working on a feature, handling personal data, or changing the code. Filenames are stable, so links to individual documents keep working.

## Operations

Runbooks for the event: deploying, the day itself, failover and support.

| Document                                                    | What it covers                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [`deployment.md`](./operations/deployment.md)               | Production runbook: first deploy, the 16-step verification, rehearsals, the day itself, updates, rollback, teardown             |
| [`fallback.md`](./operations/fallback.md)                   | Standalone server that keeps the public hostname answering while the stack restarts: what it serves, cut-over, the closing page |
| [`static-site.md`](./operations/static-site.md)             | The closing page as static files on Cloudflare Pages: build, rehearsal, cut-over, zone rules afterwards, decommission           |
| [`standby.md`](./operations/standby.md)                     | Warm standby on a second host: the per-minute snapshot, failover, cut-back and what a failover can lose                         |
| [`event-day-support.md`](./operations/event-day-support.md) | Event-day support session on dev-server: what it can do, the data-controller sign-off, log stripping, rehearsal, teardown           |
| [`db-cheatsheet.md`](./operations/db-cheatsheet.md)         | psql access, seeding, which role for what                                                                                       |
| [`imports.md`](./operations/imports.md)                     | Loading the roster and volunteer permissions from CSV: how to run, columns, reports                                             |
| [`event-report.md`](./operations/event-report.md) | Post-event report from the teardown exports: inputs, the two ways to build it, tabs, metric definitions, privacy |

## Infrastructure

How the stack is isolated and fronted: the edge, the containers and static assets.

| Document                                                                | What it covers                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| [`cloudflare-rules.md`](./infrastructure/cloudflare-rules.md)           | Edge WAF, rate rules and Access, as the record to rebuild the dashboard from                             |
| [`container-containment.md`](./infrastructure/container-containment.md) | Keeping a compromised container off the host and the LAN: the egress filter, segmentation and its checks |
| [`asset-delivery.md`](./infrastructure/asset-delivery.md)               | How CSS, fonts and JS reach the browser; the font subsetting recipe                                      |

## Performance

Capacity, limits and behaviour under load.

| Document                                                       | What it covers                                                                                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`load-testing.md`](./performance/load-testing.md)             | Event-day load test: the limiter model, the stack, the runs, how a session is recorded and judged, what it means                                               |
| [`load-test-results.md`](./performance/load-test-results.md)   | Every recorded load-test session by host and commit: capacity, shedding past the knee, limiter balance. Generated — do not edit; run `npm run loadtest:report` |
| [`overload-behaviour.md`](./performance/overload-behaviour.md) | Past capacity or on a stalled network: load shedding, every timeout, the client deadline, safe re-taps                                                         |
| [`rate-limiting.md`](./performance/rate-limiting.md)           | Principles, the limiter catalogue, the route matrix and operation                                                                                              |

## Features

What each feature does, who it is for and how it is configured.

| Document                                                                      | What it covers                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [`admin-scopes.md`](./features/admin-scopes.md)                               | What each administrator scope opens and enables, and which to grant for each job                        |
| [`survey.md`](./features/survey.md)                                           | The questionnaire: who gets it and when, authoring questions, anonymity, organiser controls, export     |
| [`redemption-options.md`](./features/redemption-options.md)                   | The approved t-shirt, volunteer t-shirt, meal, drink and lunch values, and how the editor enforces them |
| [`whatsapp-integration.md`](./features/whatsapp-integration.md)               | Sending ticket codes, delivery receipts, Meta and `.env` setup                                          |
| [`whatsapp-message-api-errors.md`](./features/whatsapp-message-api-errors.md) | Reference copy of Meta's Cloud API error codes                                                          |

## Security and privacy

Security records, incident handling and personal-data policy.

| Document                                                                      | What it covers                                                                                                     |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [`security-overview.md`](./security/security-overview.md)                     | Security posture by layer, load-bearing constraints, accepted risks, the pre-event checklist and the audit history |
| [`incident-response.md`](./security/incident-response.md)                     | Generic runbook for a breach or leak: triage, containment, evidence, notification, recovery                        |
| [`data-retention.md`](./security/data-retention.md)                           | Every artifact holding personal data, what destroys it, and the teardown procedure                                 |

## Development

Conventions for changing the code and the copy.

| Document                                                               | What it covers                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`typescript-conventions.md`](./development/typescript-conventions.md) | Four rules that each exist because the alternative breaks at runtime or silently              |
| [`copy-management.md`](./development/copy-management.md)               | How user-facing text is stored, checked, reviewed and translated                              |
| [`copy-inventory.md`](./development/copy-inventory.md)                 | Every pt-BR message with its rationale. Generated — do not edit; run `npm run i18n:inventory` |
| [`roadmap.md`](./development/roadmap.md)                               | Configurable events: per-event settings in `/admin`, branding, WhatsApp templates, country codes, roster filters |
| [`admin-export-plan.md`](./development/admin-export-plan.md)           | Result exports in `/admin/exports`: shared CSV building, anonymous and pseudonymous variants, download audit |
| [`admin-import-plan.md`](./development/admin-import-plan.md)           | Roster and volunteer-permission CSV import in `/admin/import`: preview then commit, the web and CLI write paths |
| [`qr-scanner-speed-plan.md`](./development/qr-scanner-speed-plan.md)   | Faster QR scanning: where the time goes, the native detector with a WebAssembly fallback, focus |
| [`static-demo-plan.md`](./development/static-demo-plan.md)             | Public demo on Cloudflare Pages: rendered fixtures, an in-browser mock API, read-only admin |

## Design

The visual identity.

| Document                       | What it covers                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| [`brand.md`](./design/brand.md) | The PelicanPass mark, wordmarks, colours with contrast, backdrop, motifs, type and icon files |

## Reports

What happened when the app ran for real.

| Document                                               | What it covers                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| [`event-2026-10-17.md`](./reports/event-2026-10-17.md) | The live event against the load test: attendance, redemptions, WhatsApp, incidents, data gaps and follow-ups |

## Top level

| Document                                               | What it covers                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`reviewer-guide.pt-BR.md`](./reviewer-guide.pt-BR.md) | Entry point for pt-BR reviewers: repository map, infrastructure and security review checklists, in Portuguese                                      |
| [`support/`](./support/index.md)                       | System prompt and read-only permissions (`settings.json`) for the event-day support Claude session; described in `operations/event-day-support.md` |
