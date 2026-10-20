/**
 * Builds one real template payload, and optionally sends it.
 *
 * Two jobs, and the first one is the valuable one. Printing the JSON body and
 * reading it by eye against the approved template in WhatsApp Manager catches
 * the two failures that would otherwise burn an entire run — `132000`, a body
 * variable count that does not match, and `132001`, a language code spelled
 * `pt-BR` instead of `pt_BR` — for the price of reading one object.
 *
 * **Dry by default.** `--send` is what actually messages somebody. A script
 * whose bare invocation reaches a stranger is the wrong shape for a file that
 * will be run half-remembered months from now.
 *
 *   docker compose exec app node scripts/whatsapp/send-test.ts --ticket XYABC12
 *   docker compose exec app node scripts/whatsapp/send-test.ts --ticket XYABC12 --send
 *   docker compose exec app node scripts/whatsapp/send-test.ts --ticket XYABC12 --to 5511987654321 --send
 *
 * Reads a real attendee so the button carries a `ticket_link_token` that
 * actually resolves, which is the only way the "does the link open /checkin"
 * check means anything. It reads through the application's own pool, so it
 * runs on `app` with the credentials the server already holds.
 */
import '../../src/config/env.ts';

import { env } from '../../src/config/env.ts';
import {
  WHATSAPP_TEMPLATES,
  isWhatsappTemplateKey,
} from '../../src/constants/whatsapp-templates.ts';
import {
  buildTemplatePayload,
  sendTemplate,
} from '../../src/modules/whatsapp/whatsapp.client.ts';
import { toE164 } from '../../src/modules/whatsapp/whatsapp.phone.ts';
import db from '../../src/shared/db/postgres.ts';
import { DEFAULT_TEMPLATE } from './defaults.ts';

/**
 * Reads one `--flag value` pair off the command line.
 *
 * @param flag - The flag to look for, including its dashes.
 * @returns The value that followed it, or undefined.
 */
const arg = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);

  return index === -1 ? undefined : process.argv[index + 1];
};

const ticket = arg('--ticket');
const templateKey = arg('--template') ?? DEFAULT_TEMPLATE;
const override = arg('--to');
const send = process.argv.includes('--send');

if (ticket === undefined) {
  console.error(
    `Usage: send-test.ts --ticket <code> [--template <key>, default ${DEFAULT_TEMPLATE}] [--to <e164>] [--send]`,
  );
  process.exit(1);
}

if (!isWhatsappTemplateKey(templateKey)) {
  console.error(`Unknown template "${templateKey}".`);
  console.error(`Known: ${Object.keys(WHATSAPP_TEMPLATES).join(', ')}`);
  process.exit(1);
}

const template = WHATSAPP_TEMPLATES[templateKey];

const { rows } = await db.query<{
  attendee_name: string;
  attendee_phone: string;
  ticket_code: string;
  ticket_link_token: string;
  team: string | null;
  checkin_time: string | null;
  lunch_option: string | null;
}>(
  `SELECT attendee_name, attendee_phone, ticket_code, ticket_link_token,
          team, checkin_time, lunch_option
     FROM attendees
    WHERE ticket_code = $1 AND event_id = $2`,
  [ticket, env.eventId],
);

const attendee = rows[0];

if (attendee === undefined) {
  console.error(`No attendee with ticket code "${ticket}" in this event.`);
  await db.end();
  process.exit(1);
}

const normalised = toE164(
  attendee.attendee_phone,
  env.whatsapp.defaultCountryCode,
);

if (!normalised.ok) {
  console.error(`That attendee's number was refused: ${normalised.reason}.`);
  console.error(
    'A run would record this row as skipped rather than failing it.',
  );
  await db.end();
  process.exit(1);
}

const to = override ?? normalised.e164;

console.log(`Template : ${template.name} / ${template.language}`);
console.log(`Recipient: ${to}${override === undefined ? '' : ' (overridden)'}`);
console.log('');
console.log('Read this against WhatsApp Manager before sending:');
console.log('  - body parameters, in {{1}}..{{n}} order and the right count');
console.log('  - the ticket code in the body exactly as it is on the pass');
console.log('  - language.code spelled with an underscore');
console.log('  - button index quoted as a string');
console.log('  - the button parameter is a bare token, not a URL');
console.log('');
console.log(
  JSON.stringify(buildTemplatePayload(template, to, attendee), null, 2),
);

if (!send) {
  console.log('');
  console.log('Dry run. Nothing was sent. Pass --send to send it.');
  await db.end();
  process.exit(0);
}

if (!env.whatsapp.enabled) {
  console.error('');
  console.error(
    'WHATSAPP_ENABLED is false, so there are no credentials to send with.',
  );
  await db.end();
  process.exit(1);
}

console.log('');
console.log('Sending...');

const outcome = await sendTemplate(template, to, attendee);

if (outcome.ok) {
  console.log(
    `Accepted. wamid=${outcome.wamid} status=${outcome.messageStatus}`,
  );
  console.log(`wa_id=${outcome.waId}`);

  if (outcome.waId !== '' && outcome.waId !== to) {
    console.log('');
    console.log('wa_id differs from what was sent — this is the ninth-digit');
    console.log('canonicalisation, and it is why both values get stored.');
  }
} else {
  console.log(
    `Refused. code=${String(outcome.code)} class=${outcome.classification}`,
  );
  console.log(`title=${outcome.title}`);
  if (outcome.detail !== null) console.log(`detail=${outcome.detail}`);
  console.log('');
  console.log(
    'Classified rather than thrown, which is the contract under test.',
  );
}

await db.end();
