import { installErrorReporting } from '../core/telemetry/report-error.ts';

/**
 * The global error reporter's entry point.
 *
 * Thin on purpose. The reporter lives under `core/` with the rest of the client
 * plumbing, and this exists only so the bundler emits it: `ENTRY_PATTERNS` in
 * `scripts/build-client.ts` globs `pages/**` and `theme/**` and `telemetry/**`,
 * so a module under `core/` is reachable through an import and never as a
 * `<script src>`.
 *
 * Same shape as `theme/theme.ts`, the other bundle both layouts load on every
 * page.
 */
installErrorReporting();
