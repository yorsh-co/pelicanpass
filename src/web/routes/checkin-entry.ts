import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { env } from '../../config/env.ts';
import { toAudienceRole } from '../../constants/audience.ts';
import { TICKET_INPUT_PATTERN } from '../../constants/ticket.ts';
import { getCopy, inlineCatalogs } from '../../i18n/server.ts';
import { CheckinService } from '../../modules/checkin/checkin.service.ts';
import {
  CheckinNotOpenError,
  NotFoundError,
  RateLimitError,
  ValidationError,
} from '../../shared/errors/app-error.ts';
import { LANDING_THEME_COLOR } from '../landing/landing-view.ts';

/** The part of {@link CheckinService} the entry route uses. */
export type CheckinEntryService = Pick<CheckinService, 'init'>;

/** Builds the service for one request. */
export type CheckinEntryServiceFactory = (
  req: Request,
  res: Response,
) => CheckinEntryService;

const defaultServiceFactory: CheckinEntryServiceFactory = (req, res) =>
  new CheckinService({ req, res });

/**
 * Whether the browser reports the request as started by another site.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be written by a page.
 * `none` (an address typed, a bookmark, an app opening a link), `same-origin`
 * and `same-site` are not cross-site, and neither is a client that sends no
 * such header.
 *
 * @param req - The request.
 */
const isCrossSite = (req: Request): boolean =>
  req.headers['sec-fetch-site'] === 'cross-site';

/**
 * Draws the page that asks the visitor to continue, writing no session.
 *
 * The entry token is carried in a hidden field and posted back to this origin
 * by the visitor's tap, which is what `POST /checkin` expects.
 *
 * @param req - The request.
 * @param res - The response.
 * @param field - Which entry parameter the token came from.
 * @param token - The token, echoed into the form.
 */
const renderContinue = (
  req: Request,
  res: Response,
  field: 't' | 'k',
  token: string,
): void => {
  res.render('pages/attendee/checkin/continue', {
    layout: 'layouts/plain',
    title: res.locals.chrome.titleCheckin({ appTitle: env.appTitle }),
    themeColor: LANDING_THEME_COLOR,
    tokenField: field,
    token,
    audience: toAudienceRole(req.query.audience),
    copy: getCopy(res.locals.locale, ['checkin']),
  });
};

/**
 * Answers a failed entry: the errors a visitor can cause redirect back to the
 * page with a code the client turns into a toast; anything else is the error
 * handler's.
 */
const handleError = (
  err: unknown,
  tokens: Record<string, unknown>,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  if (
    err instanceof ValidationError ||
    err instanceof NotFoundError ||
    err instanceof RateLimitError ||
    err instanceof CheckinNotOpenError
  ) {
    req.log.warn(
      {
        code: err.code,
        message: err.message,
        t: tokens.t ? '[present]' : undefined,
        k: tokens.k ? '[present]' : undefined,
      },
      'Checkin init redirecting on error',
    );

    return res.redirect('/checkin?error=' + err.code);
  }

  next(err);
};

/**
 * `GET /checkin`: the check-in page, and the entry point for the ticket link
 * (`?t=`) and the poster QR code (`?k=`).
 *
 * @param createService - Builds the check-in service; overridden in tests.
 */
export const checkinEntry =
  (
    createService: CheckinEntryServiceFactory = defaultServiceFactory,
  ): RequestHandler =>
  async (req, res, next) => {
    try {
      const service = createService(req, res);

      // Express types query values as string | ParsedQs | (…)[] | undefined.
      // A repeated or nested parameter is treated as absent, the same as a
      // link that carried neither.
      const { k, t } = req.query;

      if (isCrossSite(req)) {
        const field = typeof t === 'string' ? 't' : 'k';
        const token = field === 't' ? t : k;

        if (typeof token === 'string') {
          return renderContinue(req, res, field, token);
        }
      }

      const result = await service.init({
        qrToken: typeof k === 'string' ? k : undefined,
        linkToken: typeof t === 'string' ? t : undefined,
      });

      // The entry token has been consumed into the session, so drop it from the
      // URL rather than leaving it in the address bar and browser history. The
      // follow-up request resumes from the session it just wrote. `audience`
      // survives the redirect because it selects the page copy.
      if (t !== undefined) {
        const audience = toAudienceRole(req.query.audience);

        const target =
          audience !== undefined ? `/checkin?audience=${audience}` : '/checkin';

        return res.redirect(303, target);
      }

      res.render('pages/attendee/checkin/checkin', {
        title: res.locals.chrome.titleCheckin({ appTitle: env.appTitle }),
        nodeEnv: env.nodeEnv,
        turnstileSiteKey: env.captcha.siteKey,
        audience: toAudienceRole(req.query.audience),
        // Sourced from the same constant as the server validator and the
        // browser input, so the three cannot drift apart.
        ticketPattern: TICKET_INPUT_PATTERN,
        initialData: {
          ...result,
        },
        messages: inlineCatalogs(res.locals.locale, ['checkin', 'qr']),
        copy: getCopy(res.locals.locale, ['checkin', 'qr']),
      });
    } catch (err) {
      handleError(err, req.query, req, res, next);
    }
  };

/**
 * `POST /checkin`: the entry a visitor confirms on the continue page.
 *
 * Takes the token from the form body and performs the same entry as `GET`, then
 * redirects to the bare page. Mounted behind `requireSameOrigin`, so only this
 * site's own form reaches it with a session cookie to write.
 *
 * @param createService - Builds the check-in service; overridden in tests.
 */
export const checkinEntryPost =
  (
    createService: CheckinEntryServiceFactory = defaultServiceFactory,
  ): RequestHandler =>
  async (req, res, next) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    try {
      const { k, t, audience } = body;
      const role = toAudienceRole(audience);
      const target =
        role !== undefined ? `/checkin?audience=${role}` : '/checkin';

      if (typeof k !== 'string' && typeof t !== 'string') {
        return res.redirect(303, target);
      }

      await createService(req, res).init({
        qrToken: typeof k === 'string' ? k : undefined,
        linkToken: typeof t === 'string' ? t : undefined,
      });

      res.redirect(303, target);
    } catch (err) {
      handleError(err, body, req, res, next);
    }
  };
