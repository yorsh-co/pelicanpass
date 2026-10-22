import { qsOptional } from '../../../../layouts/main/dom.ts';
import { renderClock as renderClockInto } from '../../../../modules/ui/clock.ts';
import { renderWindowProgress } from '../../../../modules/ui/window-progress.ts';
import { dateTimeLocale } from '../../../../../../i18n/locales.ts';
import { checkinAtOptions } from './checkin-at.ts';
import { PASS_COPY } from './messages.ts';
import { displayTicketCode } from '../../../../../../constants/ticket.ts';
import {
  WELCOME_CUSTOM_PHASE,
  isChipShown,
} from '../../../../../../constants/pass.ts';

import type { BandState } from '../../../../modules/ui/band-loop.ts';
import type {
  AttendeePass,
  AttendeePassItem,
} from '../../../../core/api/api.attendee.ts';
import type { AttendeeProfile } from '../../../../../../types/attendee.ts';
import type { AccessTier } from '../../../../../../constants/access-tier.ts';
import type { WelcomeLinePhase } from '../../../../../../constants/pass.ts';

/**
 * One redemption row on the pass: what it is, which size or choice was
 * registered, and whether it has been collected.
 */
interface Chip {
  label: string;
  value: string | null;
  redeemedAt: string | Date | null;
}

/**
 * Reads a pass slot by its `data-pass` name.
 *
 * Optional throughout: the pass is one template shared by both roles, and a
 * missing slot should leave a gap rather than take the page down on the one
 * screen an attendee sees after checking in.
 */
const slot = (name: string) => qsOptional(`[data-pass="${name}"]`);

/**
 * Formats the check-in moment in the page's locale: 24-hour time, with an
 * abbreviated month in English and the full month name elsewhere.
 *
 * `checkinAt` arrives as a JSON string rather than a `Date` — it was serialised
 * into the page by the server — so it is parsed here rather than assumed.
 *
 * @param value - Timestamp from the profile.
 * @returns A localised day and time, or an empty string if there is no usable
 *   timestamp.
 */
const formatCheckinAt = (value: string | Date | null | undefined): string => {
  if (!value) return '';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const lang = document.documentElement.lang;

  return new Intl.DateTimeFormat(
    dateTimeLocale(lang),
    checkinAtOptions(lang),
  ).format(date);
};

/**
 * Whether the volunteer holds an action: a staff link on the actions face.
 * Set by {@link renderPass} from the profile, like the links themselves, and
 * read by {@link renderAccess}: a tab with nothing behind it would open an
 * empty view.
 */
let hasActions = false;

/**
 * Shows a volunteer's access tier on the pass: the access tab and its chip,
 * and the `data-access` hook the stylesheet paints the tab and the actions
 * face from.
 *
 * A label of what the volunteer can do, never a gate; the server re-checks
 * every request on its own.
 *
 * @param tier - The tier from the profile or a poll; `null` for a participant,
 *   who has no tab, and `undefined` for a payload the client could not read,
 *   which leaves the pass as it is.
 */
export const renderAccess = (tier: AccessTier | null | undefined): void => {
  if (tier === undefined) return;

  const pass = slot('pass');
  if (pass instanceof HTMLElement) {
    if (tier === null || tier === 'none') delete pass.dataset.access;
    else pass.dataset.access = tier;
  }

  const tab = slot('accessTab');
  if (tab) tab.hidden = !hasActions || tier === null;

  const chip = slot('accessChip');
  if (chip) chip.textContent = tier === null ? '' : PASS_COPY.accessBadge(tier);
};

/**
 * Builds one chip element.
 *
 * The redemption state is carried by a word as well as by colour — `retirado`
 * against `a retirar` — so it survives being read aloud, printed, or looked at
 * by someone who does not separate the two hues.
 *
 * The chip is a button that turns the pass over to its QR. A collected one is
 * disabled: there is nothing left to present, and the button under the chips is
 * the way round for a pass with nothing pending at all.
 */
const renderChip = ({ label, value, redeemedAt }: Chip): HTMLLIElement => {
  const li = document.createElement('li');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pass-chip';

  const isRedeemed = Boolean(redeemedAt);
  button.classList.toggle('is-redeemed', isRedeemed);
  button.disabled = isRedeemed;

  const name = document.createElement('span');
  name.className = 'pass-chip-name';
  name.textContent = value ? PASS_COPY.chipName(label, value) : label;

  const state = document.createElement('span');
  state.className = 'pass-chip-state';
  state.textContent = isRedeemed ? PASS_COPY.redeemed : PASS_COPY.pending;

  button.append(name, state);

  if (!isRedeemed) {
    button.ariaLabel = PASS_COPY.chipAriaLabel(name.textContent);
  }

  li.append(button);

  return li;
};

/**
 * Writes the name on its own line.
 *
 * The nickname wins when there is one, and the registered first name is what it
 * falls back to — the same resolution the server would do, kept here because
 * the editor re-renders this line without reloading the page.
 *
 * Exported so the editor can update one line rather than re-render the whole
 * pass, which would rebuild the chips for no reason.
 *
 * @param profile - The attendee profile from the store.
 */
export const renderDisplayName = (profile: Partial<AttendeeProfile>): void => {
  const nameEl = slot('displayName');
  if (!nameEl) return;

  nameEl.textContent =
    profile.attendeeNickname ?? profile.attendeeFirstName ?? '';
};

/**
 * Writes the redemption chips.
 *
 * Shared by the page's first render and by every poll after it, so a redemption
 * recorded at the counter reaches the attendee's own screen within a window
 * rather than waiting for them to reload — which they will not think to do with
 * a volunteer already handing them a t-shirt. The polls on either face also
 * retire a collected chip once `REDEEMED_CHIP_VISIBLE_MS` has passed.
 *
 * @param chips - One entry per slot, in the order they should read.
 */
const renderChips = (chips: Chip[]): void => {
  const chipList = slot('chips');
  if (!chipList) return;

  const now = Date.now();

  chipList.replaceChildren(
    // Unentitled slots are left off, and collected ones once their hour is up;
    // both faces poll often enough that no separate timer is needed.
    ...chips
      .filter((chip) => isChipShown(chip.value, chip.redeemedAt, now))
      .map(renderChip),
  );
};

/**
 * Writes the chips from the redemption slots a poll reported.
 *
 * @param items - The payload's slots, in the order they should read.
 */
export const renderItems = (items: AttendeePassItem[]): void => {
  renderChips(
    items.map((entry) => ({
      label: PASS_COPY.chips[entry.item],
      value: entry.value,
      redeemedAt: entry.redeemedAt,
    })),
  );
};

/**
 * Writes the welcome line under the name in the phase a poll reported.
 *
 * No slot for a volunteer with a team, whose line shows the team instead, and
 * no phase from a payload that carried none usable; either leaves the line as
 * it is. A `custom` phase shows the administrator's text as written, as plain
 * text.
 *
 * `survey` never replaces `thanks`: an answer is never withdrawn, so that is a
 * poll sent before the submit landed, and the next one will say `thanks` too.
 *
 * @param phase - The phase this attendee's pass is in.
 * @param text - The line to show for `custom`.
 */
export const renderWelcome = (
  phase?: WelcomeLinePhase,
  text?: string,
): void => {
  const el = slot('copy-welcome');

  if (!el || !phase) return;
  if (phase === 'survey' && el.dataset.phase === 'thanks') return;

  if (phase === WELCOME_CUSTOM_PHASE) {
    if (!text) return;

    el.textContent = text;
  } else {
    el.textContent = PASS_COPY.welcome(phase);
  }

  el.dataset.phase = phase;
};

/**
 * Renders the rotating half of the pass.
 *
 * Kept apart from {@link renderPass} rather than folded into it: the profile
 * arrives once with the page and the band arrives every thirty seconds, and a
 * single function taking both would invite a caller to pass a stale profile
 * just to refresh a band.
 *
 * @param pass - The payload from the pass endpoint, or the page's seed.
 */
export const renderLive = (pass: AttendeePass): void => {
  const qr = slot('passQr');
  if (qr instanceof HTMLImageElement) qr.src = pass.qr;

  renderItems(pass.items);
  renderWelcome(pass.welcome, pass.welcomeText);
  renderAccess(pass.accessTier);

  // Absent together: with the band off the template renders no slot and the
  // endpoint sends no word, so neither half of this is a state to recover from.
  const band = slot('passBand');

  if (band && pass.band) {
    band.textContent = pass.band.word;

    // The colour is decoration and the word is the identity, so the hue rides
    // on a data attribute the stylesheet reads rather than on an inline style.
    band.dataset.colour = pass.band.colour.toLowerCase();
  }

  // Refilled here rather than left to the next tick: this is the window
  // boundary, which is the moment the bar is most likely to be looked at.
  renderWindow(pass.expiresInMs);

  setBandState('live');
};

/**
 * Puts the band slot into one of its three states.
 *
 * A band that stopped rotating four minutes ago is worse than no band at all: a
 * crisp word reads as current and the volunteer comparing it has no way to
 * tell. So the word goes and a button to fetch a fresh one takes its place —
 * but only once it has been gone long enough to mean something.
 *
 * `pending` covers the gap at the other end of that judgement: the band has
 * expired and its replacement is in flight, which is a second of nothing rather
 * than a screen that has stopped. It hides the word behind a placeholder — the
 * two screens refresh independently, so a readable word during the gap can be
 * the *previous* one and refuse someone who is fine. Nothing else is unsafe
 * meanwhile: a token stays valid for two windows, so the code still verifies.
 *
 * Two class toggles and nothing else — what each state shows and hides is the
 * stylesheet's business, so there is no second copy of it here to disagree.
 *
 * @param state - Which state to show.
 */
export const setBandState = (state: BandState): void => {
  const block = slot('passLive');

  block?.classList.toggle('is-stale', state === 'stale');
  block?.classList.toggle('is-pending', state === 'pending');
};

/**
 * Writes the wall-clock time onto the pass.
 *
 * The device's own clock, deliberately. Its job is to be visibly moving — a
 * screenshot's is frozen — and a volunteer compares it against the phone in
 * their own hand, so being right to the second matters less than ticking.
 */
export const renderClock = (): void => {
  const el = slot('passClock');
  if (el) renderClockInto(el);
};

/**
 * Draws how much of the current window is left.
 *
 * The band says *which* window; this says where in it. The volunteer's screen
 * draws the same bar from the same server-issued window, so the two sit at the
 * same level — a continuous check beside the discrete one the word gives.
 *
 * @param remainingMs - Time left in the window.
 */
export const renderWindow = (remainingMs: number): void => {
  const el = slot('passWindow');
  if (el) renderWindowProgress(el, remainingMs);
};

/**
 * Fills the pass from the attendee's profile.
 *
 * Everything here is fixed for the life of the event — the name, the number,
 * the ticket code — so it is written once from what the server rendered into
 * the page. The chips are seeded here too, and then kept current by
 * {@link renderItems}, which both faces' polls call.
 *
 * @param profile - The attendee profile from the store.
 */
export const renderPass = (profile: Partial<AttendeeProfile>): void => {
  const {
    ticketCode,
    canRedeem,
    canDraw,
    showAdminLink,
    checkinNumber,
    checkinAt,
    attendeeRole,
    attendeeFirstName,
    tshirtSize,
    tshirtRedeemedAt,
    tshirtVolunteerSize,
    tshirtVolunteerRedeemedAt,
    mealOption,
    mealRedeemedAt,
    drinkOption,
    drinkRedeemedAt,
    lunchOption,
    lunchRedeemedAt,
  } = profile;

  // No role branch: every attendee has a ticket code, in one shape or the
  // other, and it is the only identifier a volunteer can fall back on for
  // someone who has no check-in number.
  const ticketEl = slot('ticketCode');
  if (ticketEl) {
    ticketEl.textContent = ticketCode ? displayTicketCode(ticketCode) : '';
  }

  // Keyed on the permission rather than on the role: a volunteer without it has
  // nothing to do there, and the server would redirect them straight back.
  const staffLink = slot('staffLink');

  if (staffLink) {
    staffLink.hidden = canRedeem !== true;
  }

  // The other surface, on its own permission. A volunteer may hold either, both
  // or neither: running the draw and working a redemption counter are separate
  // jobs, so this is not a second reading of `canRedeem`.
  const raffleLink = slot('raffleLink');

  if (raffleLink) {
    raffleLink.hidden = canDraw !== true;
  }

  // A shortcut, not a permission: `/admin` has its own login, so this flag is
  // independent of the two above and grants nothing by being set.
  const adminLink = slot('adminLink');

  if (adminLink) {
    adminLink.hidden = showAdminLink !== true;
  }

  renderDisplayName(profile);

  // Who the volunteer is serving, in the words their own review uses: the
  // number for a participant, the *registered* first name for a volunteer, who
  // has none. Never the nickname — it is the one string on the pass its holder
  // controls, which is what makes it worthless as an identity check.
  const identityEl = slot('identityValue');

  if (identityEl) {
    identityEl.textContent =
      checkinNumber === null || checkinNumber === undefined
        ? (attendeeFirstName ?? '')
        : `#${String(checkinNumber)}`;
  }

  const hasNumber = checkinNumber !== null && checkinNumber !== undefined;

  if (hasNumber) {
    const numberEl = slot('checkinNumber');
    if (numberEl) numberEl.textContent = `#${String(checkinNumber)}`;
  }

  const numberBlock = slot('checkinNumberBlock');
  if (numberBlock) numberBlock.hidden = !hasNumber;

  const isVolunteer = attendeeRole === 'volunteer';

  hasActions = canRedeem === true || canDraw === true || showAdminLink === true;

  // The chip lives on the access tab for a volunteer with actions (see
  // `renderAccess`); one without any has no tab, so it keeps the plain marker
  // in the header.
  const badge = slot('roleBadge');
  if (badge) {
    const showBadge = isVolunteer && !hasActions;
    badge.textContent = showBadge ? PASS_COPY.volunteerBadge : '';
    badge.hidden = !showBadge;
  }

  // A profile cached before the tier existed carries none: the tab then waits
  // for the first poll.
  renderAccess(profile.accessTier);

  // A volunteer's map is the icon in the foot; a participant's is the chip in
  // the link row, which is otherwise empty for them.
  const mapChip = slot('mapChip');
  if (mapChip) mapChip.hidden = isVolunteer;

  const mapIcon = slot('mapIcon');
  if (mapIcon) mapIcon.hidden = !isVolunteer;

  const dateEl = slot('checkinAt');
  if (dateEl) dateEl.textContent = formatCheckinAt(checkinAt);

  renderChips([
    {
      label: PASS_COPY.chips.tshirt_volunteer,
      value: tshirtVolunteerSize ?? null,
      redeemedAt: tshirtVolunteerRedeemedAt ?? null,
    },
    {
      label: PASS_COPY.chips.lunch,
      value: lunchOption ?? null,
      redeemedAt: lunchRedeemedAt ?? null,
    },
    {
      label: PASS_COPY.chips.tshirt,
      value: tshirtSize ?? null,
      redeemedAt: tshirtRedeemedAt ?? null,
    },
    {
      label: PASS_COPY.chips.meal,
      value: mealOption ?? null,
      redeemedAt: mealRedeemedAt ?? null,
    },
    {
      label: PASS_COPY.chips.drink,
      value: drinkOption ?? null,
      redeemedAt: drinkRedeemedAt ?? null,
    },
  ]);
};
