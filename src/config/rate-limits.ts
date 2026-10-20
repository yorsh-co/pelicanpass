/**
 * Every rate-limiter quota, in one place.
 *
 * Keyed by Redis prefix, which is the name the metrics panel, the `Rate
 * limiter consumed` log line and `docs/performance/rate-limiting.md` already use. The
 * reasoning behind each number lives on the limiter it sizes, in
 * `src/middleware/rate.middleware.ts`; this file only holds the numbers.
 *
 * Any entry can be overridden at boot through `RATE_LIMIT_OVERRIDES`, which is
 * what makes a quota a `.env` edit on the night rather than a release. See
 * {@link resolveRateLimits}.
 */

/** Points-per-duration quota for one limiter bucket, in seconds. */
export interface LimiterQuota {
  readonly points: number;
  readonly duration: number;
  /** How long a key stays refused once over quota, regardless of the window. */
  readonly blockDuration?: number;
}

export const DEFAULT_RATE_LIMITS = {
  // Per-IP, tiered: strict for everyone, `:trusted` for TRUSTED_IPS.
  /** Cost. @see ipLimiter */
  'rl:ip': { points: 300, duration: 60 },
  'rl:ip:trusted': { points: 2_000, duration: 60 },
  /** Cost. @see webLimiter */
  'rl:ip:web': { points: 300, duration: 60 },
  'rl:ip:web:trusted': { points: 1_000, duration: 60 },
  /** Cost. @see checkinEntryIpLimiter */
  'rl:ip:checkin-entry': { points: 60, duration: 60 },
  'rl:ip:checkin-entry:trusted': { points: 600, duration: 60 },
  /** Cost. @see adminLoginLimiter */
  'rl:ip:admin-login': { points: 10, duration: 60 },
  'rl:ip:admin-login:trusted': { points: 30, duration: 60 },

  // Per-session.
  /** Cost. @see checkinSessionLimiter */
  'rl:session:checkin': { points: 20, duration: 60 },
  /** Cost. @see attendeeSessionLimiter */
  'rl:session:attendee': { points: 30, duration: 60 },
  /** Cost. @see adminSessionLimiter */
  'rl:session:admin': { points: 20, duration: 60 },
  /** Cost. @see staffSessionLimiter */
  'rl:session:staff': { points: 60, duration: 60 },
  /** Cost. @see metricsPollLimiter */
  'rl:session:admin:metrics': { points: 60, duration: 60 },
  /** Cost. @see whatsappPollLimiter */
  'rl:session:admin:whatsapp': { points: 60, duration: 60 },
  /** Cost. @see redemptionsPollLimiter */
  'rl:session:admin:redemptions': { points: 60, duration: 60 },

  // Cookie-keyed pacing.
  /** Pacing. @see checkinEntryPacingLimiter */
  'rl:session:checkin_session_id': { points: 20, duration: 60 },

  // IP + global pairs.
  /** Cost. @see consumeClientErrorBudget */
  'rl:ip:client-errors': { points: 60, duration: 60 },
  'rl:global:client-errors': { points: 300, duration: 60 },
  /** Cost. @see consumeWhatsappWebhookBudget */
  'rl:ip:whatsapp-webhook': { points: 600, duration: 60 },
  'rl:global:whatsapp-webhook': { points: 1_200, duration: 60 },

  // Failure budgets.
  /** Control. @see consumeAdminLoginFailure */
  'rl:admin:login-failures': { points: 10, duration: 900, blockDuration: 900 },
  /** Control. @see consumeCheckinEntryFailure */
  'rl:global:checkin-entry-failures': { points: 30, duration: 60 },
  /** Control. @see consumeVerificationFailure */
  'rl:attendee:verification-failures': {
    points: 10,
    duration: 900,
    blockDuration: 900,
  },
  /** Control. @see consumeStaffLookupFailure */
  'rl:staff:lookup-failures': { points: 15, duration: 300, blockDuration: 300 },

  // Spend.
  /** Cost. @see consumeWhatsappDoorBudget */
  'rl:admin:whatsapp-door': { points: 30, duration: 600 },

  /**
   * In-process ceiling on `/readyz`. Not a Redis prefix: this limiter is
   * memory-only and unregistered. @see readyzRateLimit
   */
  readyz: { points: 300, duration: 60 },
} as const satisfies Record<string, LimiterQuota>;

/** A bucket name that has a quota. */
export type RateLimitKey = keyof typeof DEFAULT_RATE_LIMITS;

/** Effective quotas after overrides, and which keys were overridden. */
export interface ResolvedRateLimits {
  readonly limits: Readonly<Record<RateLimitKey, LimiterQuota>>;
  readonly overridden: readonly RateLimitKey[];
}

const OVERRIDE_RE = /^([^=\s]+)\s*=\s*(\d+)\/(\d+)$/;

const isRateLimitKey = (key: string): key is RateLimitKey =>
  Object.hasOwn(DEFAULT_RATE_LIMITS, key);

/**
 * Applies `RATE_LIMIT_OVERRIDES` on top of {@link DEFAULT_RATE_LIMITS}.
 *
 * The format is `prefix=points/duration`, comma-separated, matching the
 * notation of the tables in `docs/performance/rate-limiting.md`:
 * `rl:ip=600/60, rl:ip:web:trusted=2000/60`.
 *
 * Only `points` and `duration` can be overridden. `blockDuration` keeps its
 * default: a lockout length is not something to tune under pressure.
 *
 * Strict on purpose. A typo in a prefix would otherwise override nothing and
 * boot cleanly, which is the failure this is least able to afford.
 *
 * @param raw - The variable's value; empty means no overrides.
 * @throws {Error} At boot, if an entry is malformed, names an unknown prefix,
 *   is not a positive integer, or repeats a prefix.
 */
export const resolveRateLimits = (raw: string): ResolvedRateLimits => {
  const limits: Record<RateLimitKey, LimiterQuota> = { ...DEFAULT_RATE_LIMITS };
  const overridden: RateLimitKey[] = [];

  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = OVERRIDE_RE.exec(entry);

    if (!match) {
      throw new Error(
        `RATE_LIMIT_OVERRIDES contains "${entry}", which must be "prefix=points/duration", as in "rl:ip=600/60"`,
      );
    }

    const [, key = '', points = '', duration = ''] = match;

    if (!isRateLimitKey(key)) {
      throw new Error(
        `RATE_LIMIT_OVERRIDES names "${key}", which is not a rate limiter. Valid prefixes: ${Object.keys(DEFAULT_RATE_LIMITS).join(', ')}`,
      );
    }

    if (overridden.includes(key)) {
      throw new Error(`RATE_LIMIT_OVERRIDES names "${key}" more than once`);
    }

    const quota = { points: Number(points), duration: Number(duration) };

    if (quota.points < 1 || quota.duration < 1) {
      throw new Error(
        `RATE_LIMIT_OVERRIDES contains "${entry}", whose points and duration must both be at least 1`,
      );
    }

    limits[key] = { ...limits[key], ...quota };
    overridden.push(key);
  }

  return { limits: Object.freeze(limits), overridden };
};
