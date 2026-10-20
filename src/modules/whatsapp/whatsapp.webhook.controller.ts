import crypto from 'node:crypto';

import { verifyWebhookSignature } from './whatsapp.signature.ts';

import { env } from '../../config/env.ts';
import { applyReceipt } from '../admin/admin.whatsapp.repository.ts';
import { consumeWhatsappWebhookBudget } from '../../middleware/rate.middleware.ts';
import { RateLimitError } from '../../shared/errors/app-error.ts';
import { actorOf } from '../../shared/telemetry/actor.ts';
import { count } from '../../shared/telemetry/counters.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import { sendAlert } from '../../shared/telemetry/alerts.ts';
import { maskUrlSecrets } from '../../shared/utils/mask.ts';

import type { RequestHandler } from 'express';

import type {
  ReceiptEvent,
  ReceiptStatus,
} from '../admin/admin.whatsapp.repository.ts';

/**
 * Meta's delivery receipts: the handshake that registers the callback, and the
 * receiver that moves `delivery_status`.
 *
 * **The first genuinely public inbound write this application holds**, so most
 * of this file is refusals. The blast radius is what sizes them: the most a
 * forged request achieves — *even one carrying a valid signature* — is marking
 * already-sent messages delivered or read. It cannot send a message, cannot
 * read a phone number back out (every response here is empty), cannot insert a
 * row (the only verb is `UPDATE`, matched on a `wamid` it would have to know)
 * and cannot delete one (migration `018` grants no `DELETE` to anybody).
 *
 * **Nothing from the body is logged.** `recipient_id` arrives on every single
 * status event and it is a phone number; `docs/security/data-retention.md` promises the
 * operation logs carry none.
 */

/** Longest `errors[].title` kept. It is for grouping, not for reading prose. */
const MAX_ERROR_TITLE = 200;

/** The four states Meta reports, and the only ones this reads. */
const STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

/**
 * Reads a string field, bounded.
 *
 * @param value - Whatever the parser left behind.
 * @param max - Longest value kept.
 */
const str = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.length > 0
    ? value.slice(0, max)
    : undefined;

/**
 * Reads Meta's Unix-seconds timestamp.
 *
 * Sent as a **string** of seconds, which `Date` would read as milliseconds if
 * handed over unconverted — putting every receipt in 1970. Anything
 * unparseable falls back to now: the timestamp is recorded, never compared, so
 * a wrong one costs a display value and a missing one would cost the row.
 *
 * @param value - `statuses[].timestamp`, as it arrived.
 */
const readTimestamp = (value: unknown): Date => {
  const seconds = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;

  return Number.isFinite(seconds) ? new Date(seconds * 1_000) : new Date();
};

/**
 * Walks the payload for status events, keeping only what is named.
 *
 * An allow-list walk in the shape of `parseReport`
 * (`client-error.controller.ts`), field by field and never a shape cast: this
 * is untrusted input from the open internet.
 *
 * **`value.messages[]` is deliberately not read here or anywhere below.** It
 * carries attendees' own replies, and decision 6 is that this application does
 * not process inbound messages. There is no dashboard setting that would do it
 * for us — subscribing to receipts *is* subscribing to the `messages` field,
 * and the field is indivisible — so this early return is the control.
 *
 * @param body - Whatever the parser left behind.
 * @returns Every status event the payload carried, in arrival order.
 */
const parseReceipts = (body: unknown): ReceiptEvent[] => {
  if (typeof body !== 'object' || body === null) return [];

  const entries = (body as { entry?: unknown }).entry;

  if (!Array.isArray(entries)) return [];

  const events: ReceiptEvent[] = [];

  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;

    const changes = (entry as { changes?: unknown }).changes;

    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (typeof change !== 'object' || change === null) continue;

      const value = (change as { value?: unknown }).value;

      if (typeof value !== 'object' || value === null) continue;

      const statuses = (value as { statuses?: unknown }).statuses;

      if (!Array.isArray(statuses)) continue;

      for (const raw of statuses) {
        if (typeof raw !== 'object' || raw === null) continue;

        const row = raw as Record<string, unknown>;

        const wamid = str(row.id, 200);
        const status = str(row.status, 20);

        if (!wamid || !status || !STATUSES.has(status)) continue;

        const error = Array.isArray(row.errors)
          ? (row.errors[0] as Record<string, unknown> | undefined)
          : undefined;

        const code = error?.code;

        events.push({
          wamid,
          status: status as ReceiptStatus,
          occurredAt: readTimestamp(row.timestamp),
          errorCode: typeof code === 'number' ? code : null,
          errorTitle: str(error?.title, MAX_ERROR_TITLE) ?? null,
        });
      }
    }
  }

  return events;
};

/**
 * Meta's callback verification.
 *
 * Answers the challenge verbatim as `text/plain`, which is what Meta's
 * dashboard expects; anything else and the subscription will not save.
 *
 * The token is compared with the length-guard idiom rather than `===`, for the
 * reason `pass.service.ts` gives — and because this is the one place in the
 * feature where a credential legitimately travels in a query string, which is
 * why `hub.verify_token` is in `SECRET_PARAMS`.
 *
 * Charged against the same budget as {@link receive}, before the token is
 * compared. The path is exempt from `ipLimiter`, and every refusal writes a
 * `warn` line to the durable log, so an unmetered handshake would be an
 * unbounded disk writer. Meta sends one per subscription save, which costs the
 * receipt budget nothing.
 */
export const handshake: RequestHandler = async (req, res, next) => {
  try {
    const budget = await consumeWhatsappWebhookBudget(req.ip ?? 'unknown');

    if (budget.blocked) {
      throw new RateLimitError('Too many handshakes', budget.retryAfterSeconds);
    }

    const { 'hub.mode': mode, 'hub.challenge': challenge } = req.query;
    const token = req.query['hub.verify_token'];

    const received = Buffer.from(
      typeof token === 'string' ? token : '',
      'utf8',
    );
    const expected = Buffer.from(env.whatsapp.webhookVerifyToken, 'utf8');

    const matches =
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected);

    if (mode !== 'subscribe' || !matches || typeof challenge !== 'string') {
      req.log.warn({ mode }, 'WhatsApp webhook handshake refused');

      res.sendStatus(403);

      return;
    }

    req.log.info('WhatsApp webhook handshake accepted');

    res.type('text/plain').send(challenge);
  } catch (err) {
    next(err);
  }
};

/**
 * Applies one batch of delivery receipts.
 *
 * **Always answers `2xx` once the signature holds**, including for a payload
 * that matched no rows and for one carrying only inbound messages. A non-`2xx`
 * is what makes Meta retry, and eventually disable the subscription — so the
 * only failures worth signalling are the ones a retry could fix.
 *
 * The rate budget is charged **before** any verification work, so a flood costs
 * a Redis increment rather than an HMAC per request.
 */
export const receive: RequestHandler = async (req, res, next) => {
  try {
    const budget = await consumeWhatsappWebhookBudget(req.ip ?? 'unknown');

    if (budget.blocked) {
      throw new RateLimitError('Too many receipts', budget.retryAfterSeconds);
    }

    if (
      !verifyWebhookSignature(req.rawBody, req.headers['x-hub-signature-256'])
    ) {
      // Nothing from the body: not the payload, not a prefix of it, not its
      // length. A forged request must learn nothing from what we write down.
      req.log.warn('WhatsApp webhook signature refused');

      recordEvent({
        severity: 'warn',
        kind: 'security',
        code: 'FORBIDDEN',
        message: 'WhatsApp webhook signature refused',
        route: maskUrlSecrets(req.originalUrl),
        statusCode: 403,
        requestId: typeof req.id === 'string' ? req.id : undefined,
        ...actorOf(req),
      });

      // Deduplicated by fingerprint, so a sustained attempt is one message
      // rather than one per request.
      sendAlert({
        severity: 'warn',
        title: 'WhatsApp webhook signature refused',
        fingerprint: 'whatsapp:webhook:signature',
        means:
          'Something posted to the receipt callback without a valid signature. Meta always signs, so this is a scan or a forgery attempt — it changed nothing.',
        check:
          'Cloudflare Security Events for the callback path. If this is sustained, custom rule 4 is not doing its job.',
      });

      res.sendStatus(403);

      return;
    }

    const events = parseReceipts(req.body);

    let applied = 0;

    for (const event of events) {
      // Zero rows matched is a success, not a 404: a receipt for a purged row,
      // or for a test send — which writes no `whatsapp_sends` row by design —
      // is expected, and anything but a 2xx teaches Meta to retry something
      // that will never match.
      if (await applyReceipt(event)) applied += 1;

      if (event.status === 'delivered') count('whatsapp.delivered');
      if (event.status === 'read') count('whatsapp.read');
    }

    // Counts only, and no `recipient_id`: it is a phone number, and it arrives
    // on every event.
    if (events.length > 0) {
      req.log.info(
        { events: events.length, applied },
        'WhatsApp receipts applied',
      );
    }

    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
};
