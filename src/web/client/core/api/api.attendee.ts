import { request } from './api.request.ts';

import { isAccessTier } from '../../../../constants/access-tier.ts';
import {
  WELCOME_CUSTOM_PHASE,
  isWelcomePhase,
} from '../../../../constants/pass.ts';

import type { AccessTier } from '../../../../constants/access-tier.ts';
import type {
  RedemptionItem,
  WelcomeLinePhase,
} from '../../../../constants/pass.ts';

/** Ends the attendee session and clears its cookie. Responds 204, no body. */
export const logout = async (): Promise<void> =>
  request<undefined>('/api/v1/attendee/logout', {
    method: 'POST',
  });

/** One redemption slot, as the poll reports it. */
export interface AttendeePassItem {
  item: RedemptionItem;
  value: string | null;
  redeemedAt: string | null;
}

/** Whether the questionnaire is open to this attendee, and answered. */
export interface AttendeeSurveyState {
  open: boolean;
  completed: boolean;
}

/** The rotating half of the pass, as the server issues it. */
export interface AttendeePass {
  /** The window's band, absent where `PASS_BAND_ENABLED` is off. */
  band?: { colour: string; word: string };
  token: string;
  qr: string;
  items: AttendeePassItem[];
  expiresInMs: number;

  /**
   * Absent when the payload carried none in a usable shape. The card is then
   * left as it is rather than hidden on a guess.
   */
  survey?: AttendeeSurveyState;

  /**
   * The volunteer's access tier, or `null` for a participant. Absent when the
   * payload carried an unknown value, and the pass is then left as it is.
   */
  accessTier?: AccessTier | null;

  /**
   * Which text the welcome line shows. Absent when the payload carried an
   * unknown phase, or `custom` without its text, and the line is then left as
   * it is.
   */
  welcome?: WelcomeLinePhase;

  /** The line an administrator wrote, present only with `custom`. */
  welcomeText?: string;
}

/**
 * Keeps the welcome line's fields from a payload when they are usable
 * together: a built-in phase, or `custom` with a non-empty text.
 *
 * @param welcome - The payload's `welcome`.
 * @param welcomeText - The payload's `welcomeText`.
 * @returns The fields to spread into the parsed result, or none.
 */
const readWelcome = (
  welcome: unknown,
  welcomeText: unknown,
): Pick<AttendeePass, 'welcome' | 'welcomeText'> => {
  if (isWelcomePhase(welcome)) return { welcome };

  return welcome === WELCOME_CUSTOM_PHASE &&
    typeof welcomeText === 'string' &&
    welcomeText !== ''
    ? { welcome, welcomeText }
    : {};
};

/**
 * Keeps the access tier from a payload when it is one this build knows, or
 * `null`, which is a participant's.
 *
 * @param accessTier - The payload's `accessTier`.
 * @returns The field to spread into the parsed result, or none.
 */
const readAccessTier = (
  accessTier: unknown,
): Pick<AttendeePass, 'accessTier'> =>
  accessTier === null || isAccessTier(accessTier) ? { accessTier } : {};

/** Response envelope of the pass endpoint. */
interface PassResponse {
  data?: Partial<AttendeePass>;
}

/**
 * Fetches a fresh token, QR and — where it is enabled — band.
 *
 * @returns The pass payload, or `null` if the response carried no usable one —
 *   which the caller treats exactly like a failed request, because a pass
 *   missing its code is not something to render.
 *
 *   The band is not part of that test. A deployment with `PASS_BAND_ENABLED`
 *   off sends none, and failing the refresh over it would stop the token
 *   rotating — which is the half of this payload the scanner actually reads. A
 *   band that arrives malformed is dropped rather than rendered, for the same
 *   reason a stale one is covered: a word that cannot be trusted is worse on
 *   screen than no word at all.
 */
export const getPass = async (): Promise<AttendeePass | null> => {
  const res = await request<PassResponse>('/api/v1/attendee/pass');

  const {
    band,
    token,
    qr,
    items,
    expiresInMs,
    survey,
    accessTier,
    welcome,
    welcomeText,
  } = res.data ?? {};

  if (
    !token ||
    !qr ||
    !Array.isArray(items) ||
    typeof expiresInMs !== 'number'
  ) {
    return null;
  }

  return {
    ...(band?.word ? { band } : {}),
    token,
    qr,
    items,
    expiresInMs,
    ...(typeof survey?.open === 'boolean' &&
    typeof survey.completed === 'boolean'
      ? { survey }
      : {}),
    ...readAccessTier(accessTier),
    ...readWelcome(welcome, welcomeText),
  };
};

/**
 * The front of the pass: the redemption slots, the questionnaire's state and
 * the welcome line's phase.
 */
export type AttendeePassStatus = Pick<
  AttendeePass,
  'items' | 'survey' | 'welcome' | 'welcomeText' | 'accessTier'
>;

/** Response envelope of the status endpoint. */
interface StatusResponse {
  data?: Partial<AttendeePassStatus>;
}

/**
 * Fetches the redemption slots, the questionnaire's state and the welcome
 * line's phase, without a token or QR.
 *
 * @returns The status, or `null` if the response carried no usable slots.
 */
export const getPassStatus = async (): Promise<AttendeePassStatus | null> => {
  const res = await request<StatusResponse>('/api/v1/attendee/status');

  const { items, survey, accessTier, welcome, welcomeText } = res.data ?? {};

  if (!Array.isArray(items)) return null;

  return {
    items,
    ...(typeof survey?.open === 'boolean' &&
    typeof survey.completed === 'boolean'
      ? { survey }
      : {}),
    ...readAccessTier(accessTier),
    ...readWelcome(welcome, welcomeText),
  };
};

/** Response envelope of the nickname endpoint. */
interface NicknameResponse {
  data?: { nickname?: string | null };
}

/**
 * Sets or clears the name shown on the pass.
 *
 * @param nickname - Value to store. An empty string clears it and the pass
 *   falls back to the registered first name.
 * @returns The **stored** value, which is the server's normalised form of what
 *   was sent — rendering the typed value instead would drift from what the next
 *   page load shows.
 * @throws {ApiError} With code `VALIDATION_ERROR` if the value breaks the
 *   character policy.
 */
export const setNickname = async (nickname: string): Promise<string | null> => {
  const res = await request<NicknameResponse>('/api/v1/attendee/nickname', {
    method: 'PATCH',
    json: { nickname },
  });

  return res.data?.nickname ?? null;
};
