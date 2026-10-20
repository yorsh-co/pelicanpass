import type { RequestHandler } from 'express';

import { env } from '../config/env.ts';
import { TurnstileValidator } from '../modules/captcha/captcha.service.ts';
import { CaptchaRequiredError } from '../shared/errors/app-error.ts';

/** The Turnstile `action` this route accepts, and nothing else. */
const EXPECTED_ACTION = 'admin-login';

/**
 * Requires a solved Turnstile on the administrator sign-in.
 *
 * **Deliberately not a variant of `requireCaptchaIfFlagged`**
 * (`src/middleware/captcha.middleware.ts`). That one is welded to the check-in
 * session and its flag-and-clear lifecycle: it returns
 * early when no such session exists, which on this route is every request, so it
 * would wave the whole surface through. Admin sign-in has no session to flag —
 * issuing one is what it is for.
 *
 * No "only when flagged" condition either. A handful of sign-ins per event makes
 * that machinery worth nothing, and the point here is narrower than rate
 * limiting: it establishes that a human is present before a password is tried.
 *
 * **Mounted between `adminLoginLimiter` and the router, and that order is
 * load-bearing.** The limiter first, so an IP flood is refused before it costs a
 * siteverify call. This second, because `login` in
 * `src/modules/admin/admin.service.ts` calls `consumeAdminLoginFailure` up
 * front, on every attempt, before it even looks the account up — so without a
 * challenge in front of it a bot can lock a volunteer out of their own account
 * with nothing but their username.
 *
 * `expectedAction` is what keeps a token minted against the attendee widget from
 * being replayed here; the two share a team but not a key or an action. No
 * `expectedHostname`: the form answers on both the public and tailnet hostnames
 * while both paths stand, and the widget's own domain allowlist is that control.
 *
 * **A refusal and a failure are indistinguishable from here.** `validate` never
 * throws — a malformed token, a network failure and a timeout all come back as
 * an unsuccessful result — so a Cloudflare outage would close the one surface
 * the volunteers have. That is what `TURNSTILE_ADMIN_ENFORCE` is for, and why
 * the pass-through logs: the state has to be readable from the logs rather than
 * inferred from a refusal that never came.
 */
export const requireAdminLoginCaptcha: RequestHandler = async (
  req,
  _res,
  next,
) => {
  try {
    if (!env.captchaAdmin.enforce) {
      req.log.warn('Admin sign-in captcha not enforced');

      return next();
    }

    const captcha = new TurnstileValidator(env.captchaAdmin.secret);

    // Express types req.body as `any`; the token is validated by
    // TurnstileValidator, which takes it as `unknown` for that reason.
    const body = req.body as { captchaToken?: unknown } | undefined;

    const result = await captcha.validate(body?.captchaToken, {
      remoteIp: req.ip,
      expectedAction: EXPECTED_ACTION,
    });

    if (!result.success) {
      req.log.warn({ result }, 'Admin sign-in captcha invalid');

      return next(new CaptchaRequiredError());
    }

    next();
  } catch (err) {
    next(err);
  }
};
