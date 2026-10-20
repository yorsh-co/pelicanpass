import type { RequestHandler } from 'express';

import {
  getDrawPermission,
  getRedeemPermission,
} from '../modules/attendee/attendee.repository.ts';
import { getAdminPermission } from '../modules/admin/admin.repository.ts';
import { actorOf } from '../shared/telemetry/actor.ts';
import { recordEvent } from '../shared/telemetry/record.ts';
import { isRedemptionItem } from '../constants/pass.ts';
import { ForbiddenError } from '../shared/errors/app-error.ts';
import { maskUrlSecrets } from '../shared/utils/mask.ts';

import type { AdminScope } from '../constants/admin-scopes.ts';
import type { RedemptionItem } from '../constants/pass.ts';

/**
 * Records a refusal as a durable security event.
 *
 * A second sink beside the `req.log.warn` each call site already writes, not a
 * second log line — `recordEvent` does not log.
 *
 * Each of these also becomes an `http_error` row when the `ForbiddenError`
 * reaches the error handler, and that is intended rather than duplication to
 * remove: the two answer different questions. The `http_error` row says a
 * request got a 403; this one says *which permission* an actor was refused,
 * which is the only form the question takes when reading the security panel.
 * They never collide in the errors view — these are `warn`, and that view is
 * `error` and above.
 *
 * @param req - The refused request.
 * @param message - What was refused, matching the log line beside it.
 * @param fields - Extra detail. Scrubbed at the sink; pass no personal data.
 */
const recordSecurity = (
  req: Parameters<RequestHandler>[0],
  message: string,
  fields?: Readonly<Record<string, string | number | boolean>>,
): void => {
  recordEvent({
    severity: 'warn',
    kind: 'security',
    code: 'FORBIDDEN',
    message,
    route: maskUrlSecrets(req.originalUrl),
    statusCode: 403,
    requestId: typeof req.id === 'string' ? req.id : undefined,
    ...actorOf(req),
    ...(fields ? { fields } : {}),
  });
};

/**
 * What the session on this request may redeem, or `null` if it may not.
 *
 * **An empty scope set is a refusal, not a permission to redeem nothing.**
 * `migrations/010_redeem-scopes.ts` constrains the column with `<@`, which
 * admits `'{}'` — every array is a subset of the vocabulary, including the empty
 * one. Returned as `[]` that is a truthy value, so `can_redeem` with no stations
 * used to pass this gate and open the staff surface: the holder could resolve
 * any attendee by ticket code through `/staff/lookup` and read their identifier
 * and entitlements, while every `/staff/redeem` answered 403. Read access
 * granted by a state that reads as "no permission" is the wrong way round.
 *
 * Collapsing it to `null` is also what keeps the two callers honest — every
 * "may not redeem" case now leaves by the same door, rather than one of them
 * arriving as an empty-but-truthy array a caller has to remember to test.
 *
 * @param req - Request carrying an already-narrowed attendee session.
 */
const redeemScopes = async (req: {
  session?: { type?: string; attendeeId?: string | null };
}): Promise<RedemptionItem[] | null> => {
  const session = req.session;

  if (session?.type !== 'attendee' || !session.attendeeId) return null;

  const permission = await getRedeemPermission(session.attendeeId);

  if (permission?.attendee_role !== 'volunteer' || !permission.can_redeem) {
    return null;
  }

  const scopes = permission.redeem_scopes.filter(isRedemptionItem);

  return scopes.length > 0 ? scopes : null;
};

/**
 * Gates the staff surface on a volunteer's redeem permission.
 *
 * Reads Postgres. The read is per request rather than baked into the session on
 * login, allowing for permissions to be withdrawn after the attendee session has
 * been minted.
 *
 * Throws `403 ForbiddenError` to distinguish from `401`.
 *
 * Leaves the volunteer's scopes on the request for handling by StaffService.
 *
 * Must be mounted after `requireSessionType('attendee')`.
 */
export const requireRedeemPermission: RequestHandler = async (
  req,
  _res,
  next,
) => {
  try {
    const scopes = await redeemScopes(req);

    if (!scopes) {
      req.log.warn(
        { attendeeId: req.sessionIds?.attendee },
        'Redeem permission refused',
      );

      recordSecurity(req, 'Redeem permission refused');

      return next(new ForbiddenError());
    }

    req.redeemScopes = scopes;

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * The same gate for a rendered page, which redirects instead of erroring.
 *
 * @param redirectTo - Where to send someone without the permission.
 */
export const requireRedeemPermissionWeb =
  (redirectTo: string): RequestHandler =>
  async (req, res, next) => {
    try {
      if (!(await redeemScopes(req))) return res.redirect(redirectTo);

      next();
    } catch (err) {
      next(err);
    }
  };

/**
 * Whether the session on this request belongs to a permitted draw operator.
 *
 * Deliberately a separate predicate from {@link mayRedeem} rather than a shared
 * one taking a flag. The two surfaces are gated independently and are reached
 * by different people — counter staff work a station for four hours, the draw
 * is run once from a stage — so a change made to widen one must not be able to
 * widen the other by passing through shared code.
 *
 * @param req - Request carrying an already-narrowed attendee session.
 */
const mayDraw = async (req: {
  session?: { type?: string; attendeeId?: string | null };
}): Promise<boolean> => {
  const session = req.session;

  if (session?.type !== 'attendee' || !session.attendeeId) return false;

  const permission = await getDrawPermission(session.attendeeId);

  return permission?.attendee_role === 'volunteer' && permission.can_draw;
};

/**
 * Gates the raffle API on a volunteer's draw permission.
 *
 * The same shape as {@link requireRedeemPermission}, reading the other flag,
 * and per request for the same reason: an attendee session lives 24 hours, so a
 * permission carried inside one could not be withdrawn during an event.
 *
 * Must be mounted after `requireSessionType('attendee')`.
 */
export const requireDrawPermission: RequestHandler = async (
  req,
  _res,
  next,
) => {
  try {
    if (!(await mayDraw(req))) {
      req.log.warn(
        { attendeeId: req.sessionIds?.attendee },
        'Draw permission refused',
      );

      recordSecurity(req, 'Draw permission refused');

      return next(new ForbiddenError());
    }

    next();
  } catch (err) {
    next(err);
  }
};

/**
 * The same gate for the rendered raffle page, which redirects instead of
 * erroring.
 *
 * A volunteer who taps a bookmarked `/raffle` after the draw has been handed to
 * somebody else should land on their own pass. Nothing is wrong with their
 * session; there is simply nothing for them here.
 *
 * @param redirectTo - Where to send someone without the permission.
 */
export const requireDrawPermissionWeb =
  (redirectTo: string): RequestHandler =>
  async (req, res, next) => {
    try {
      if (!(await mayDraw(req))) return res.redirect(redirectTo);

      next();
    } catch (err) {
      next(err);
    }
  };

/**
 * Whether the administrator on this request holds a given scope.
 *
 * Takes the scope as an argument rather than being one predicate per scope,
 * which looks like the shared-helper shape the two gates above deliberately
 * avoid — but it is not the same thing. What those two refuse to share is the
 * *decision*: `can_redeem` and `can_draw` are separate flags on separate
 * surfaces, and one function reading a flag chosen by a parameter could be
 * widened for one caller and silently widen the other. Here the scope **is**
 * the decision, stored as a set, and the check is set membership. There is one
 * behaviour, applied to a value, rather than two behaviours behind a switch.
 *
 * @param req - Request carrying an already-narrowed admin session.
 * @param scope - Scope the route requires.
 */
export const hasAdminScope = async (
  req: { session?: { type?: string; adminId?: string | null } },
  scope: AdminScope,
): Promise<boolean> => {
  const session = req.session;

  if (session?.type !== 'admin' || !session.adminId) return false;

  const permission = await getAdminPermission(session.adminId);

  if (!permission?.is_active) return false;

  return permission.admin_scopes.includes(scope);
};

/**
 * Gates an admin route on one scope.
 *
 * Reads Postgres per request rather than trusting the session, so narrowing an
 * administrator's scopes or deactivating them takes effect on their next
 * action. An admin session lives an hour and slides; a permission carried
 * inside one could not be withdrawn while somebody was still using it.
 *
 * Throws `403 ForbiddenError` to distinguish from `401`: the session is fine,
 * the permission is not. The admin UI depends on that difference to tell "sign
 * in again" from "you may not do this".
 *
 * Must be mounted after `requireSessionType('admin')`.
 *
 * @param scope - Scope the route requires.
 */
export const requireAdminScope =
  (scope: AdminScope): RequestHandler =>
  async (req, _res, next) => {
    try {
      if (!(await hasAdminScope(req, scope))) {
        req.log.warn(
          { adminId: req.sessionIds?.admin, scope },
          'Admin scope refused',
        );

        recordSecurity(req, 'Admin scope refused', { scope });

        return next(new ForbiddenError());
      }

      next();
    } catch (err) {
      next(err);
    }
  };

/**
 * The same gate for a rendered page, which redirects instead of erroring.
 *
 * @param scope - Scope the page requires.
 * @param redirectTo - Where to send an administrator without it.
 */
export const requireAdminScopeWeb =
  (scope: AdminScope, redirectTo: string): RequestHandler =>
  async (req, res, next) => {
    try {
      if (!(await hasAdminScope(req, scope))) return res.redirect(redirectTo);

      next();
    } catch (err) {
      next(err);
    }
  };
