import { maskUrlSecrets } from '../../shared/utils/mask.ts';
import { actorOf } from '../../shared/telemetry/actor.ts';
import { recordEvent } from '../../shared/telemetry/record.ts';
import { count } from '../../shared/telemetry/counters.ts';
import type { Request, Response } from 'express';

import { adminSession } from './admin.session.adapter.ts';
import { DUMMY_HASH, verifyPassword } from './admin.password.ts';
import { getAdminByUsername, touchAdminLogin } from './admin.repository.ts';

import {
  consumeAdminLoginFailure,
  resetAdminLoginFailures,
} from '../../middleware/rate.middleware.ts';
import {
  RateLimitError,
  UnauthorizedError,
} from '../../shared/errors/app-error.ts';

import type { AdminScope } from '../../constants/admin-scopes.ts';

/** Request and response the service acts on. */
interface AdminServiceParams {
  req: Request;
  res: Response;
}

/** What the browser is told about the administrator who just signed in. */
export interface AdminIdentity {
  username: string;
  scopes: AdminScope[];
}

/**
 * Longest password accepted at the door.
 *
 * Not a policy about good passwords — it is a bound on work. scrypt runs over
 * an HMAC of the input, so length costs nothing in the KDF, but there is no
 * reason to read an unbounded string off the wire and hash it. The JSON body
 * limit is already 10 KB; this makes the intent local.
 */
const MAX_PASSWORD_LENGTH = 256;

const MAX_USERNAME_LENGTH = 64;

/**
 * Sign-in and sign-out for the administrator surface.
 *
 * The failure path is uniform on purpose. An unknown username, a wrong
 * password and a deactivated account all produce the same
 * {@link UnauthorizedError} with the same message, and all three cost the same
 * time — see {@link login}. Anything that distinguishes them turns this
 * endpoint into a roster oracle for whoever is on the tailnet.
 */
export class AdminService {
  private readonly req: Request;
  private readonly res: Response;

  constructor({ req, res }: AdminServiceParams) {
    this.req = req;
    this.res = res;
  }

  /**
   * Records a sign-in refusal as a durable security event.
   *
   * A second sink beside the `req.log.warn` at each call site, not a second log
   * line — `recordEvent` does not log.
   *
   * **The username is deliberately not passed.** It stays in the log line, for
   * the reason the comment at the budget call site already gives: an
   * administrator's username is a credential half, and `app_events` is read on
   * a dashboard. The actor fields carry the session id, which is what makes a
   * refusal attributable without naming anybody.
   *
   * @param code - Stable code for the refusal.
   * @param message - What was refused, matching the log line beside it.
   */
  #recordSecurity(code: string, message: string): void {
    recordEvent({
      severity: 'warn',
      kind: 'security',
      code,
      message,
      route: maskUrlSecrets(this.req.originalUrl),
      requestId: typeof this.req.id === 'string' ? this.req.id : undefined,
      ...actorOf(this.req),
    });
  }

  /**
   * Verifies credentials and issues an administrator session.
   *
   * The order of operations matters and is not the obvious one:
   *
   * 1. The failure budget is consumed **before** the password is hashed, so a
   *    flood is refused for the price of a Redis round trip rather than 100 ms
   *    of scrypt each.
   * 2. A missing administrator still runs a verification, against a dummy hash,
   *    so the response time does not reveal whether the username exists.
   * 3. `is_active` is checked **after** the password is verified, for the same
   *    reason.
   * 4. Any existing admin session is destroyed and a fresh one created, rather
   *    than the old one being rotated. A new principal gets a new session; this
   *    is what closes session fixation, and it avoids `sessionService.rotate`,
   *    which preserves the old payload and is documented as check-in-only.
   *
   * @param username - Username as typed.
   * @param password - Password as typed.
   * @returns The identity the dashboard renders.
   * @throws {ValidationError} If either field is missing or overlong.
   * @throws {RateLimitError} If this username's failure budget is spent.
   * @throws {UnauthorizedError} For every kind of failed credential.
   */
  async login(username: string, password: string): Promise<AdminIdentity> {
    const name = username.trim().toLowerCase();

    // Bounded before anything expensive touches them. An overlong field is
    // refused as a bad credential rather than as a validation error, so that
    // probing the bounds says nothing about the roster.
    if (
      !name ||
      name.length > MAX_USERNAME_LENGTH ||
      !password ||
      password.length > MAX_PASSWORD_LENGTH
    ) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const budget = await consumeAdminLoginFailure(name);

    if (budget.blocked) {
      this.req.log.warn({ username: name }, 'Admin login budget exhausted');

      // Counted, not alerted from here: the rules loop owns thresholds, and the
      // username stays in the log line rather than travelling to Discord.
      count('admin.login.blocked');

      // A budget exhaustion is a state change rather than an event — the gate
      // is now shut for this username — which is why it earns a row where an
      // individual refused request does not. `warn` rather than `error` on
      // purpose: `error` would raise recordEvent's new-signature alert on top
      // of the critical the rules loop already sends for this condition.
      this.#recordSecurity(
        'ADMIN_LOGIN_BUDGET',
        'Admin login budget exhausted',
      );

      throw new RateLimitError('Too many attempts', budget.retryAfterSeconds);
    }

    const admin = await getAdminByUsername(name);

    // Verify regardless, so a miss costs the same as a hit.
    const verified = await verifyPassword(
      password,
      admin?.password_hash ?? (await DUMMY_HASH),
    );

    if (!admin || !verified || !admin.is_active) {
      this.req.log.warn({ username: name }, 'Admin login refused');

      this.#recordSecurity('UNAUTHORIZED', 'Admin login refused');

      throw new UnauthorizedError('Invalid credentials');
    }

    // The budget was charged up front so that a flood is refused before scrypt
    // runs. Now that the credentials are known good, hand the points back —
    // otherwise an administrator's own sign-ins would lock their account.
    await resetAdminLoginFailures(name);

    // A fresh session for a fresh principal — never a rotation of whatever was
    // presented. Destroy first: the cookie is about to be overwritten either
    // way, and leaving the old session live in Redis would strand a credential
    // nobody holds a name for.
    await adminSession.destroy(this.req, this.res);

    // The identity goes in through the adapter's overrides, so the session is
    // complete on its first and only write — no follow-up `persist`.
    await adminSession.create(this.req, this.res, {
      adminId: admin.admin_id,
      username: admin.username,
    });

    // Best-effort: the session exists and the cookie is set, so a failure to
    // record the timestamp must not become the administrator's response.
    try {
      await touchAdminLogin(admin.admin_id);
    } catch (err) {
      this.req.log.warn({ err }, 'Could not record the admin login time');
    }

    this.req.log.info({ username: admin.username }, 'Admin signed in');

    return { username: admin.username, scopes: admin.admin_scopes };
  }

  /** Ends the administrator's session and clears the cookie. */
  async logout(): Promise<void> {
    const session = this.req.session;
    const username = session?.type === 'admin' ? session.username : null;

    await adminSession.destroy(this.req, this.res);

    this.req.log.info({ username }, 'Admin signed out');
  }
}
