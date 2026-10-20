import type { RequestHandler } from 'express';

import { env } from '../config/env.ts';
import { TurnstileValidator } from '../modules/captcha/captcha.service.ts';
import { clearCaptchaRequirement } from '../modules/checkin/checkin.attempts.ts';
import { checkinSession } from '../modules/checkin/checkin.session.adapter.ts';
import { CaptchaRequiredError } from '../shared/errors/app-error.ts';
import { isCheckinFailureBudgetExhausted } from './rate.middleware.ts';

/** Behaviour switches for {@link requireCaptchaIfFlagged}. */
interface CaptchaOptions {
  /**
   * Also require a captcha while the global checkin-entry failure budget is
   * exhausted, whether or not the request carries a session.
   *
   * Only for routes whose step can actually render a captcha — in practice
   * just the ticket step. The verification and QR steps handle
   * `CAPTCHA_REQUIRED` by navigating back to the ticket step using
   * `details.nextStep`, so demanding a token there would strand an attendee
   * mid-flow with no widget to solve.
   */
  includeGlobalFailureBudget?: boolean;
}

/**
 * Requires a solved captcha on requests whose check-in session has been
 * flagged after too many failed attempts, and — where enabled — on every
 * request while the global failure budget is exhausted.
 *
 * The global condition is deliberately not session-scoped. Session state is
 * addressed by a cookie the client owns, so a lockout recorded there is cleared
 * by discarding that cookie; a request carrying no session at all is the shape
 * of the bypass, not a reason to wave it through.
 *
 * Clearing the session flag is what ends a per-session lockout, so it only
 * happens once Turnstile has accepted the token.
 *
 * One middleware rather than two composed ones because Turnstile tokens are
 * single-use: a second validation of the same token would fail.
 *
 * @param options - Behaviour switches; see {@link CaptchaOptions}.
 */
export const requireCaptchaIfFlagged =
  (options: CaptchaOptions = {}): RequestHandler =>
  async (req, _res, next) => {
    const { includeGlobalFailureBudget = false } = options;

    try {
      const existing = await checkinSession.get(req);

      const globallyRequired =
        includeGlobalFailureBudget && (await isCheckinFailureBudgetExhausted());

      if (!existing && !globallyRequired) return next();

      if (existing && !existing.session.captchaRequired && !globallyRequired) {
        return next();
      }

      const captcha = new TurnstileValidator(env.captcha.secret);

      // Express types req.body as `any`; the token is validated by
      // TurnstileValidator, which takes it as `unknown` for that reason.
      const body = req.body as { captchaToken?: unknown } | undefined;

      const result = await captcha.validate(body?.captchaToken, {
        remoteIp: req.ip,
      });

      if (!result.success) {
        req.log.warn({ result, globallyRequired }, 'Required captcha invalid');

        return next(new CaptchaRequiredError());
      }

      // Only a session carries a flag to clear. A request that was challenged
      // purely on the global budget has nothing to write back.
      if (existing) {
        const { sessionId, session } = existing;

        await checkinSession.persist(
          sessionId,
          clearCaptchaRequirement(session),
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
