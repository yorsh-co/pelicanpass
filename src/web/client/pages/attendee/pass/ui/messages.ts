import { createChromeMessages } from '../../../../../../i18n/generated/chrome.messages.ts';
import { createPassMessages } from '../../../../../../i18n/generated/pass.messages.ts';
import { createSurveyMessages } from '../../../../../../i18n/generated/survey.messages.ts';
import { readMessages } from '../../../../core/i18n.ts';

import type { AccessTier } from '../../../../../../constants/access-tier.ts';
import type {
  RedemptionItem,
  WelcomePhase,
} from '../../../../../../constants/pass.ts';

const pass = readMessages('pass', createPassMessages);
const chrome = readMessages('chrome', createChromeMessages);
const survey = readMessages('survey', createSurveyMessages);

/**
 * What the pass's script says, read from the `pass` and `chrome` catalogs the
 * route inlined. Static text is rendered by `components/pass.ejs`; this holds
 * what the script writes after load. The wording and its rationale live in
 * src/i18n/messages/pt-BR/pass.json.
 */
export const PASS_COPY = {
  volunteerBadge: chrome.roleVolunteer(),

  /** The badge's label for a volunteer tier; `none` keeps the plain volunteer badge. */
  accessBadge: (tier: AccessTier): string =>
    tier === 'none' ? chrome.roleVolunteer() : pass.accessBadge({ tier }),

  /** Item names, keyed like the database's `item` check constraint. */
  chips: {
    tshirt_volunteer: chrome.itemTshirtVolunteer(),
    lunch: chrome.itemLunch(),
    tshirt: chrome.itemTshirt(),
    meal: chrome.itemMeal(),
    drink: chrome.itemDrink(),
  } satisfies Record<RedemptionItem, string>,

  /** The line under the name, in the event's current phase. */
  welcome: (phase: WelcomePhase): string => pass.welcome({ phase }),

  pending: pass.chipPending(),
  redeemed: pass.chipRedeemed(),

  /** A chip's name with the attendee's choice for it, e.g. a size. */
  chipName: (item: string, value: string): string =>
    pass.chipName({ item, value }),

  /** Accessible name of a chip not yet collected. */
  chipAriaLabel: (name: string): string => pass.chipAriaLabel({ name }),

  nickname: {
    hint: pass.nicknameHint(),
    invalid: pass.nicknameInvalid(),
    failed: pass.nicknameFailed(),
    saved: pass.nicknameSaved(),
    cleared: pass.nicknameCleared(),
  },

  /** Flash messages for a redirect back to the pass. */
  init: {
    rateLimited: pass.initRateLimited(),
    unknownError: pass.initUnknownError(),
    recoverableError: pass.initRecoverableError(),
  },
} as const;

/**
 * What the questionnaire card's script says, read from the `survey` catalog.
 * The card itself is rendered by `components/survey-card.ejs`.
 */
export const SURVEY_COPY = {
  /** Characters typed into a text answer, against its limit. */
  counter: (count: number, max: number): string =>
    survey.counter({ count, max }),

  thanks: survey.thanks(),
  closed: survey.errorClosed(),
  answered: survey.errorAnswered(),
  stale: survey.errorStale(),
  unavailable: survey.errorUnavailable(),
  failed: survey.errorGeneric(),
} as const;
