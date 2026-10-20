/**
 * The client address each synthetic attendee presents as `X-Forwarded-For`.
 *
 * The app trusts one proxy hop, so at app:3000 this header is `req.ip`, which
 * every per-IP limiter keys on. The mapping itself is `addresses.ts`.
 */

import { addressFor, spread } from './addresses.ts';
import { settings } from './config.ts';

/**
 * The address an attendee's load-phase requests come from, under the run's
 * `IP_MODE`, `VENUE_IP`, `WIFI_SHARE` and `CARRIER_IPS`.
 *
 * @param index - Attendee index within its role.
 */
export const ipFor = (index: number): string => addressFor(index, settings);

/**
 * The address a `setup()` request comes from: always one per attendee, and
 * outside every range above, so preparing sessions spends no budget the run
 * is about to measure.
 *
 * @param index - Attendee index within its role.
 */
export const setupIpFor = (index: number): string => spread(100, index);
