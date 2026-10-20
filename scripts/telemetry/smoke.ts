/**
 * Exercises the alert path end to end without touching a route.
 *
 * Verifies the two properties that are hard to check by inspection and easy to
 * get wrong: that fifty identical firings collapse into one message, and that a
 * field on the forbidden list is censored before it leaves the host.
 *
 * The collapsed message carries no suppressed count. The repeats are counted,
 * but the count rides on the next message for that fingerprint, which cannot go
 * out until `ALERT_DEDUP_TTL` has passed — long after this process exits.
 *
 * Posts to whatever `DISCORD_WEBHOOK_URL` names, so point it at a scratch
 * channel. Deduplication and scrubbing both run on the delivery path, so with
 * `ALERT_ENABLED=false` or no webhook only the counter check is exercised.
 *
 *   docker compose exec app node scripts/telemetry/smoke.ts
 */
import '../../src/config/env.ts';

import { flushAlerts, sendAlert } from '../../src/shared/telemetry/alerts.ts';
import { bump, total } from '../../src/shared/telemetry/window.ts';

const BURST = 50;

console.log(`Firing ${String(BURST)} identical alerts...`);

for (let i = 0; i < BURST; i++) {
  sendAlert({
    severity: 'warn',
    title: 'Telemetry smoke test',
    fingerprint: 'smoke:duplicate',
    means: 'Smoke test — not a real condition.',
    check: 'Nothing. Run from scripts/telemetry/smoke.ts.',
    fields: { iteration: i, note: 'expect exactly one message' },
  });
}

console.log('Firing one alert carrying forbidden fields...');

sendAlert({
  severity: 'warn',
  title: 'Telemetry smoke test — scrubber',
  fingerprint: `smoke:scrub:${String(Date.now())}`,
  means: 'Smoke test — not a real condition.',
  check: 'Nothing. Run from scripts/telemetry/smoke.ts.',
  fields: {
    // Every one of these must arrive as [REDACTED].
    attendeeName: 'Maria Silva',
    phone: '11999998888',
    ticket: 'xabc12',
    nickname: 'mari',
    // These must survive.
    route: '/api/v1/checkin/ticket',
    statusCode: 500,
  },
});

for (let i = 0; i < 7; i++) bump('smoke.counter');

console.log(
  `Window check: expected 7, got ${String(total('smoke.counter', 1))}`,
);

await flushAlerts(10_000);

console.log(
  'Done. Expect two messages: one for the burst of fifty, one scrubbed.',
);
