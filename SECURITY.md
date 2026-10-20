# Security Policy

This project is provided **as is** under the [MIT License](./LICENSE), without warranty or support.
See the [Disclaimer](./README.md#disclaimer).

## Supported versions

Only the maintainer's own event deployment is supported. Each deployment exists for the event
window and is torn down roughly 24 hours afterwards (see
[`docs/security/data-retention.md`](./docs/security/data-retention.md)), so there are no long-lived versions to
patch. Forks and self-hosted copies are not supported.

## Reporting a vulnerability

**Do not open an issue or pull request.** Email **joshuaporter.dev@outlook.com** with the subject
`[pelicanpass] Security`, including:

- the affected route, component or configuration file;
- steps to reproduce, or a proof of concept;
- the impact you expect;
- whether any real attendee data was accessed.

Reports are handled on a best-effort basis; there is no guaranteed response time and no guarantee
of a fix. Please allow reasonable time before disclosing anything publicly.

## If you run your own deployment

You are its operator and data controller. Vulnerabilities, misconfigurations and incidents in your
deployment are yours to assess and handle, including any notification your jurisdiction requires;
[`docs/security/incident-response.md`](./docs/security/incident-response.md) is a starting point. A report about a
flaw in this codebase is still welcome through the channel above.

## Personal data

The application holds attendee names and phone numbers. A report about exposure of personal data in a
deployment goes to that deployment's operator, who is its data controller. A flaw in this codebase that
could cause such exposure is reported through the channel above.

## Scope

**In scope:** application code (`src/`), `Caddyfile`, compose files, `migrations/` and `scripts/`.

**Out of scope:**

- third-party platforms: Cloudflare, Tailscale, Meta/WhatsApp, and the external sign-up system;
- the participant ticket-code and verification-code keyspaces and the static QR poster token, which
  are structural to the event design (see
  [`docs/security/security-overview.md`](./docs/security/security-overview.md#the-code-keyspaces-and-the-poster-token));
- volumetric denial of service and social engineering.

When testing, do not access or modify data that is not yours, and do not load-test a live
deployment.

## Further reading

- [`docs/security/security-overview.md`](./docs/security/security-overview.md): current security posture, accepted
  risks, the pre-event checklist and the audit history
- [`docs/operations/deployment.md`](./docs/operations/deployment.md): stack topology and trust boundaries
- [`docs/infrastructure/container-containment.md`](./docs/infrastructure/container-containment.md): keeping a compromised
  container off the host and the LAN
- [`docs/performance/rate-limiting.md`](./docs/performance/rate-limiting.md): rate limiters and their failure modes
- [`docs/security/data-retention.md`](./docs/security/data-retention.md): what personal data is held and when it is
  destroyed
