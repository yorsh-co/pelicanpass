/**
 * The client address each synthetic attendee presents, as a pure function of
 * its index and the run's address plan. No k6 imports, so Node's test runner
 * can exercise it.
 */

/** How synthetic client addresses are spread. */
export type IpMode = 'single' | 'cgnat' | 'spread';

export const IP_MODES: readonly IpMode[] = ['single', 'cgnat', 'spread'];

/** Carrier addresses available in TEST-NET-2, 198.51.100.1 to .254. */
export const MAX_CARRIER_IPS = 254;

/** The settings that decide an attendee's address. */
export interface AddressPlan {
  readonly ipMode: IpMode;
  /** The address the whole venue shares in `single` and `cgnat` modes. */
  readonly venueIp: string;
  /** Share of the room on venue Wi-Fi in `cgnat` mode, from 0 to 1. */
  readonly wifiShare: number;
  /** Carrier addresses the rest of the room is spread across in `cgnat` mode. */
  readonly carrierIps: number;
}

/**
 * Spreads an index across a /8, so no two attendees share an address.
 *
 * @param first - First octet.
 * @param index - Attendee index.
 */
export const spread = (first: number, index: number): string =>
  `${String(first)}.${String((index >> 16) & 255)}.${String((index >> 8) & 255)}.${String(index & 255)}`;

/**
 * Attendees before `index` on venue Wi-Fi. Integer per-mille arithmetic, so
 * every prefix of the room holds its share to within one attendee and no
 * float rounding drifts it.
 *
 * @param index - Attendee index.
 * @param wifiShare - Share on Wi-Fi, from 0 to 1.
 */
const onWifiBefore = (index: number, wifiShare: number): number =>
  Math.floor((index * Math.round(wifiShare * 1000)) / 1000);

/**
 * The address an attendee's load-phase requests come from.
 *
 * - `single`: the whole room behind the venue's one public address.
 * - `cgnat`: `wifiShare` of the room on the venue address, the rest spread
 *   evenly across `carrierIps` carrier addresses.
 * - `spread`: one address each, so no per-IP limiter binds. For capacity runs.
 *
 * @param index - Attendee index within its role.
 * @param plan - The run's address settings.
 */
export const addressFor = (index: number, plan: AddressPlan): string => {
  switch (plan.ipMode) {
    case 'single':
      return plan.venueIp;
    case 'cgnat': {
      const before = onWifiBefore(index, plan.wifiShare);

      if (onWifiBefore(index + 1, plan.wifiShare) > before) return plan.venueIp;

      // Counting only the attendees off Wi-Fi keeps the carriers even: a
      // carrier picked from the raw index shares its modulus with the Wi-Fi
      // split and lands on a few carriers only.
      const carrier = (index - before) % plan.carrierIps;

      return `198.51.100.${String(1 + carrier)}`;
    }
    case 'spread':
      return spread(10, index);
  }
};
