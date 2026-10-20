/**
 * Run settings and the attendee fixtures, read once in k6's init context.
 *
 * Every setting is an `-e NAME=value` flag on `k6 run`; docs/performance/load-testing.md
 * lists them with their defaults.
 */

import { SharedArray } from 'k6/data';

import { IP_MODES, MAX_CARRIER_IPS } from './addresses.ts';

import type { IpMode } from './addresses.ts';

/** One synthetic attendee, as `scripts/loadtest/prepare.sql` prints it. */
export interface Attendee {
  readonly ticket: string;
  /** The verification code: the last four digits of the phone. */
  readonly code: string;
  /** The entry-link token a WhatsApp message carries as `?t=`. */
  readonly link: string;
  readonly role: 'participant' | 'volunteer';
  readonly canRedeem: boolean;
  readonly canDraw: boolean;
}

/**
 * Reads a number setting.
 *
 * @param name - Setting name.
 * @param fallback - Value when unset.
 * @param max - Largest accepted value.
 */
const numeric = (name: string, fallback: number, max: number): number => {
  const raw = __ENV[name];

  if (raw === undefined || raw === '') return fallback;

  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${name} must be a number from 0 to ${String(max)}`);
  }

  return value;
};

/**
 * Reads a whole-number setting of at least 1.
 *
 * @param name - Setting name.
 * @param fallback - Value when unset.
 * @param max - Largest accepted value.
 */
const count = (name: string, fallback: number, max: number): number => {
  const value = numeric(name, fallback, max);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a whole number from 1 to ${String(max)}`);
  }

  return value;
};

const ipMode = __ENV.IP_MODE ?? 'single';

if (!(IP_MODES as readonly string[]).includes(ipMode)) {
  throw new Error(`IP_MODE must be one of ${IP_MODES.join(', ')}`);
}

const qrToken = __ENV.CHECKIN_QR_TOKEN;

if (!qrToken) throw new Error('CHECKIN_QR_TOKEN is required');

export const settings = {
  baseUrl: __ENV.BASE_URL ?? 'http://app:3000',
  qrToken,
  ipMode: ipMode as IpMode,
  /** The address the whole venue shares in `single` and `cgnat` modes. */
  venueIp: __ENV.VENUE_IP ?? '203.0.113.10',
  /** Share of the room on venue Wi-Fi in `cgnat` mode. */
  wifiShare: numeric('WIFI_SHARE', 0.7, 1),
  /** Carrier addresses the rest of the room shares in `cgnat` mode. */
  carrierIps: count('CARRIER_IPS', 10, MAX_CARRIER_IPS),
  /** Multiplies every arrival rate. 1 is the event as briefed. */
  scale: numeric('SCALE', 1, 20),
  /**
   * Share of manual check-ins that mistype the ticket once first. The
   * 2026-09-26 dry run had one in 28 check-ins, about one typed ticket in ten.
   */
  typoRate: numeric('TYPO_RATE', 0.1, 1),
  /**
   * Share of all check-ins that mistype the verification code once first. The
   * dry run had three in 28.
   */
  codeTypoRate: numeric('CODE_TYPO_RATE', 0.1, 1),
  /** Share of check-ins that arrive through the WhatsApp entry link. */
  linkRate: numeric('LINK_RATE', 0.6, 1),
  /** Whether a first page view also fetches its stylesheets and scripts. */
  assets: __ENV.ASSETS !== 'false',
  /** Runs each scenario once instead of at event rates. */
  smoke: __ENV.SMOKE === 'true',
  /**
   * How many participants to use, from the start of the fixtures; all of them
   * when unset. One large roster can then serve every phase: survey needs one
   * participant per arrival, while `setup()` checks in every participant.
   */
  participants:
    __ENV.PARTICIPANTS === undefined || __ENV.PARTICIPANTS === ''
      ? null
      : numeric('PARTICIPANTS', 0, 36 ** 3),
} as const;

const load = (): Attendee[] =>
  JSON.parse(open(__ENV.FIXTURES ?? '../fixtures.json')) as Attendee[];

export const participants = new SharedArray('participants', () => {
  const all = load().filter((a) => a.role === 'participant');
  const wanted = settings.participants;

  if (wanted !== null && wanted > all.length) {
    throw new Error(
      `PARTICIPANTS=${String(wanted)}, but the fixtures hold ${String(all.length)}: import a larger roster`,
    );
  }

  return wanted === null ? all : all.slice(0, wanted);
});

export const volunteers = new SharedArray('volunteers', () =>
  load().filter((a) => a.role === 'volunteer'),
);

export const redeemers = new SharedArray('redeemers', () =>
  load().filter((a) => a.canRedeem),
);

export const drawers = new SharedArray('drawers', () =>
  load().filter((a) => a.canDraw),
);
