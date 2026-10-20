import { displayTicketCode } from './ticket.ts';

import type { AttendeeRole } from '../types/attendee.ts';

/**
 * Single source of truth for what may be sent over WhatsApp, and what may go
 * in it.
 *
 * In the spirit of {@link ../constants/admin-scopes.ts ADMIN_SCOPE_VALUES} and
 * for the same reason: the picker, the validator and the sender all read this
 * file, so a template cannot be offered by one and rejected by another.
 */

/**
 * The only attendee-derived values that may ever leave for Meta.
 *
 * **Governed by the published privacy notice**, which promises Meta receives
 * the phone number, the first name, the ticket code and the entry link, and
 * nothing else — plus, for a volunteer, details of their service at the event.
 * Adding a member here is a change to that promise, not a refactor: the notice
 * has to be revised first, unless the member is in
 * {@link VOLUNTEER_ONLY_VARIABLES} and describes the volunteer's service, which
 * that generic clause already covers.
 *
 * `attendee_nickname` is deliberately absent. It is attendee-chosen and outside
 * the promise, and its absence from this union is the enforcement rather than a
 * rule somebody has to remember.
 *
 * The phone number is not a member: it is the `to` field, not a variable.
 *
 * **A second kind of slot is coming and does not belong in this union.** A
 * template may also carry values identical for every recipient — an event date,
 * a venue, the event's name. Those are not personal data and resolve from
 * configuration rather than from an attendee row, so they need their own map
 * and their own resolver signature. It is not built yet because no approved
 * template asks for one; when one does, it goes beside this union rather than
 * inside it, and the privacy notice is untouched.
 */
export const TEMPLATE_VARIABLES = [
  'firstName',
  'ticketCode',
  'entryLinkToken',
  'team',
  'checkinTime',
  'lunchOption',
] as const;

/**
 * One attendee-derived value a template may carry. Its picker label is
 * `admin-whatsapp.variable.<variable>`.
 */
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/**
 * The variables only a volunteer holds: `team`, `checkin_time` and
 * `lunch_option` are volunteer-only columns, null for a participant. A template
 * that uses one must therefore be offered to volunteers only, or a participant's
 * message would carry a placeholder for something they do not have.
 */
export const VOLUNTEER_ONLY_VARIABLES: ReadonlySet<TemplateVariable> = new Set([
  'team',
  'checkinTime',
  'lunchOption',
]);

/**
 * What a volunteer-only variable reads when the volunteer has no value yet.
 * Meta refuses an empty body parameter, so no resolver may return `''`.
 */
const UNSET_FALLBACK = 'a definir';

/**
 * Formats a Postgres `time` the way the event writes times: `8h` on the hour,
 * `8h30` otherwise, with no leading zero on the hour.
 *
 * @param time - `HH:MM:SS`, as `pg` returns a `time` column.
 */
const formatCheckinTime = (time: string): string => {
  const [hours = '', minutes = ''] = time.split(':');
  const hour = String(Number(hours));

  return minutes === '00' ? `${hour}h` : `${hour}h${minutes}`;
};

/**
 * The columns a resolver may read.
 *
 * Its own interface rather than `Pick<AttendeeEntry, …>`, which is what it
 * ought to be: `ticket_link_token` is a real column, added by migration 004 and
 * queried in attendee.repository.ts, but it is not declared on `AttendeeEntry`
 * even though that interface calls itself a full row. Widening a shared type to
 * make one `Pick` work is out of proportion here, so the gap is recorded and
 * left for its own change.
 *
 * Narrow on purpose. There is no path from an attendee row to Meta that does
 * not pass through this type and the resolver map below.
 */
export interface TemplateAttendeeRow {
  attendee_name: string;
  ticket_code: string;
  ticket_link_token: string;
  team: string | null;
  checkin_time: string | null;
  lunch_option: string | null;
}

/**
 * How each variable is read off an attendee row.
 *
 * Typed as a total `Record` so that **the compiler enumerates every case**: a
 * member added to {@link TEMPLATE_VARIABLES} without a resolver here is a build
 * failure rather than an empty string in somebody's message.
 */
export const TEMPLATE_RESOLVERS: Record<
  TemplateVariable,
  (row: TemplateAttendeeRow) => string
> = {
  /**
   * The first name only, which is what the privacy notice promises and all the
   * application ever renders anyway.
   */
  firstName: (row) => row.attendee_name.trim().split(' ')[0] ?? '',

  /**
   * The ticket code, as the fallback for an entry link that will not open. The
   * attendee types it into the check-in ticket step by hand.
   *
   * Sent through `displayTicketCode`, uppercased, so it reads the same as the
   * code on the attendee's own pass. Codes are held lowercase and
   * `formatTicket` in constants/ticket.ts lowercases what is typed, so the
   * uppercased copy still checks in.
   *
   * With the phone number in `to`, Meta holds both halves of the manual
   * check-in: the code and the last four digits. That adds no capability Meta
   * did not already have, because {@link TEMPLATE_RESOLVERS.entryLinkToken}'s
   * value is on its own a complete entry credential.
   */
  ticketCode: (row) => displayTicketCode(row.ticket_code),

  /**
   * The bare `ticket_link_token`, and this is its **first reader in this
   * repository**.
   *
   * The value is a live per-attendee credential: whoever holds it can open that
   * attendee's entry link. It must never be logged, never rendered in the
   * preview, and never put in a URL we compose. It does not need to be — the
   * scheme, host and path all live inside Meta's approved button URL, and this
   * parameter fills the `{{1}}` at the end of it.
   */
  entryLinkToken: (row) => row.ticket_link_token,

  /**
   * The volunteer's team as stored, free text of at most 40 characters.
   */
  team: (row) => row.team ?? UNSET_FALLBACK,

  /**
   * The volunteer's check-in time as the event writes it: `8h`, `8h30`, `13h05`.
   */
  checkinTime: (row) =>
    row.checkin_time === null
      ? UNSET_FALLBACK
      : formatCheckinTime(row.checkin_time),

  /**
   * The volunteer's lunch slot, carrying its own label (`🍴 Almoço: 11h30`).
   *
   * Not every volunteer has lunch, so an absent value is a bare `-` rather than
   * {@link UNSET_FALLBACK}: a blank-looking or "a definir" slot would suggest to
   * a volunteer without lunch that they might be given one.
   */
  lunchOption: (row) =>
    row.lunch_option === null ? '-' : `🍴 Almoço: ${row.lunch_option}`,
};

/** One template, as Meta has it approved. */
export interface WhatsappTemplate {
  /**
   * Exactly as approved in WhatsApp Manager. The admin pickers and the slots
   * panel show the registry key rather than this name, with
   * {@link WhatsappTemplate.description} alongside it.
   */
  readonly name: string;

  /**
   * One line, in pt-BR, telling staff when and why this template is sent.
   * Shown under the key in the admin slots panel and in brackets after it in
   * the admin pickers.
   *
   * Written here rather than in the `admin-whatsapp` catalog so that adding a
   * template stays a one-file change. It is not translated.
   */
  readonly description: string;

  /** Underscore, not a hyphen. `pt-BR` is a 132001. */
  readonly language: string;

  /** `marketing` would pick up the per-user frequency cap that utility escapes. */
  readonly category: 'utility' | 'marketing';

  /** Which audiences this template may be aimed at. */
  readonly roles: readonly AttendeeRole[];

  /** Whether a run reaches only attendees whose check-in is complete. */
  readonly checkedInOnly: boolean;

  /** Body parameters in `{{1}}…{{n}}` order. Positional; the order is the contract. */
  readonly body: readonly TemplateVariable[];

  /** The dynamic URL button, if the template has one. */
  readonly urlButton?: {
    /** Zero-based position in the approved template, as a string. */
    readonly index: string;
    readonly variable: TemplateVariable;
  };
}

/**
 * What Meta charges per delivered message, in US dollars, by category.
 *
 * Taken from Meta's rate card for Brazilian numbers as of 2026-09, which is
 * every recipient here. Edited by hand when Meta reprices; nothing fetches it.
 *
 * Total over {@link WhatsappTemplate.category}, so a category added there
 * without a rate here is a build failure rather than a cost of `NaN`.
 */
export const TEMPLATE_PRICE_USD: Record<WhatsappTemplate['category'], number> =
  {
    utility: 0.0068,
    marketing: 0.0625,
  };

/**
 * Every template that may be sent, keyed on `name:language`.
 *
 * That pair is how Meta identifies a template and there is nothing else it goes
 * by, which is why the key is not an invented slug.
 *
 * > **The entry below is unverified.** No template is approved yet, so its
 * > name, language and body list describe what we intend to submit rather than
 * > what Meta has accepted. Reading the payload dump against WhatsApp Manager
 * > is what promotes it from intent to fact, and it is worth the five minutes:
 * > a wrong body count is a `132000` and a wrong language code a `132001`, and
 * > either one fails every message in the run rather than one of them.
 * >
 * > **The body list is the part most likely to change.** The ticket code is
 * > decided; its position after the first name is an assumption until the
 * > template is drafted, and the array has to match the draft's `{{n}}` order.
 * > Any further variable is undecided. If one is attendee-derived it needs a
 * > new member in
 * > {@link TEMPLATE_VARIABLES} and a revision to the privacy notice. If it is
 * > the same for every recipient it belongs in the second kind of slot that
 * > union's JSDoc describes.
 */
export const WHATSAPP_TEMPLATES = {
  // PARTICIPANTS
  'pax_wk_v1:pt_BR': {
    name: 'pax_wk_v1',
    description: 'PARTICIPANTE SEMANA [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['participant'],
    checkedInOnly: false,
    body: ['firstName', 'ticketCode'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  'pax_day_v1:pt_BR': {
    name: 'pax_day_v1',
    description: 'PARTICIPANTE DIA [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['participant'],
    checkedInOnly: false,
    body: ['firstName', 'ticketCode'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  'pax_door_v1:pt_BR': {
    name: 'pax_door_v1',
    description: 'PARTICIPANTE PORTA [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['participant'],
    checkedInOnly: false,
    body: ['firstName', 'ticketCode'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  'pax_survey_v1:pt_BR': {
    name: 'pax_survey_v1',
    description: 'PARTICIPANTE FEEDBACK [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['participant'],
    checkedInOnly: true,
    body: ['firstName', 'ticketCode'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  // VOLUNTEERS
  'vol_wk_v1:pt_BR': {
    name: 'vol_wk_v1',
    description: 'VOLUNTARIO SEMANA [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['volunteer'],
    checkedInOnly: false,
    body: ['firstName', 'ticketCode', 'team', 'checkinTime', 'lunchOption'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  'vol_day_v1:pt_BR': {
    name: 'vol_day_v1',
    description: 'VOLUNTARIO DIA [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['volunteer'],
    checkedInOnly: false,
    body: ['firstName', 'ticketCode', 'team', 'checkinTime', 'lunchOption'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  'vol_door_v1:pt_BR': {
    name: 'vol_door_v1',
    description: 'VOLUNTARIO PORTA [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['volunteer'],
    checkedInOnly: false,
    body: ['firstName', 'ticketCode', 'team', 'checkinTime', 'lunchOption'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
  'vol_survey_v1:pt_BR': {
    name: 'vol_survey_v1',
    description: 'VOLUNTARIO FEEDBACK [example.org]',
    language: 'pt_BR',
    category: 'utility',
    roles: ['volunteer'],
    checkedInOnly: true,
    body: ['firstName', 'ticketCode'],
    urlButton: { index: '0', variable: 'entryLinkToken' },
  },
} as const satisfies Record<string, WhatsappTemplate>;

/** One template the sender knows how to send. */
export type WhatsappTemplateKey = keyof typeof WHATSAPP_TEMPLATES;

/** Every template key, for validating a request body against. */
export const WHATSAPP_TEMPLATE_KEYS = Object.keys(
  WHATSAPP_TEMPLATES,
) as WhatsappTemplateKey[];

/** Narrows an unchecked string to a template key. */
export const isWhatsappTemplateKey = (
  value: string,
): value is WhatsappTemplateKey => Object.hasOwn(WHATSAPP_TEMPLATES, value);
