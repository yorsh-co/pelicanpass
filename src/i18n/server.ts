import { match } from '@formatjs/intl-localematcher';

import type { CookieOptions, Request, RequestHandler } from 'express';

import { env } from '../config/env.ts';
import { LOCALE_COOKIE } from '../constants/cookie-names.ts';
import { withQueryParam, withoutQueryParam } from '../shared/utils/url.ts';
import { getMessages } from './catalogs.ts';
import {
  BASE_LOCALE,
  PSEUDO_LOCALE,
  dateTimeLocale,
  isLocale,
  supportedLocales,
} from './locales.ts';

import type { Locale } from './locales.ts';

export { getCopy, getMessages, inlineCatalogs } from './catalogs.ts';

/** The locales this deployment offers. */
export const SUPPORTED = supportedLocales(env.nodeEnv);

/**
 * The locales `Accept-Language` may select.
 *
 * Never the pseudo-locale: a browser asking for `en-US` would otherwise be
 * matched to it.
 */
const NEGOTIABLE = SUPPORTED.filter((locale) => locale !== PSEUDO_LOCALE);

/** One entry of the footer's language switcher. */
export interface LocaleLink {
  locale: Locale;
  /** The language's name in that language, as switchers usually show it. */
  label: string;
  /**
   * The code the switcher shows in place of the label: the tag's region, or
   * its language when it names none.
   */
  code: string;
  /** The current path and query with `lang` set. */
  href: string;
  current: boolean;
}

const LANGUAGE_NAMES = new Map(
  SUPPORTED.map((locale) => [
    locale,
    new Intl.DisplayNames([locale], { type: 'language' }).of(locale) ?? locale,
  ]),
);

const LOCALE_CODES = new Map(
  SUPPORTED.map((locale) => {
    const { language, region } = new Intl.Locale(locale);

    return [locale, region ?? language.toUpperCase()];
  }),
);

/**
 * The switcher's links for a request, or none when there is nothing to switch
 * between.
 *
 * @param originalUrl - `req.originalUrl`.
 * @param current - The resolved locale.
 */
const localeLinks = (originalUrl: string, current: Locale): LocaleLink[] =>
  SUPPORTED.length < 2
    ? []
    : SUPPORTED.map((locale) => ({
        locale,
        label: LANGUAGE_NAMES.get(locale) ?? locale,
        code: LOCALE_CODES.get(locale) ?? locale,
        href: withQueryParam(originalUrl, 'lang', locale),
        current: locale === current,
      }));

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Options the locale cookie is written with.
 *
 * Mirrors the landing bypass cookie. `Secure` only in production, where the
 * app is served over HTTPS.
 */
const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: env.nodeEnv === 'production',
  sameSite: 'lax',
  path: '/',
  maxAge: ONE_YEAR_MS,
};

const isSupported = (value: unknown): value is Locale =>
  isLocale(value) && SUPPORTED.includes(value);

/**
 * Reports whether a tag is a well-formed BCP 47 language tag.
 *
 * The matcher throws on anything else, and `req.acceptsLanguages()` passes
 * through `*` and whatever malformed tags a client sends.
 */
const isLanguageTag = (tag: string): boolean => {
  try {
    Intl.getCanonicalLocales(tag);
    return true;
  } catch {
    return false;
  }
};

/**
 * Picks the offered locale that best fits the client's `Accept-Language`.
 *
 * @param requested - Tags in preference order, from `req.acceptsLanguages()`.
 */
const negotiate = (requested: readonly string[]): Locale => {
  const matched = match(
    requested.filter(isLanguageTag),
    NEGOTIABLE,
    BASE_LOCALE,
  );

  return isLocale(matched) ? matched : BASE_LOCALE;
};

/**
 * The locale a request asks for, without `?lang=`: the stored choice, then
 * `Accept-Language`, then the base locale.
 *
 * Exported for API handlers, which run outside `localeMiddleware` but answer
 * the same visitor.
 *
 * @param req - The request.
 */
export const resolveLocale = (req: Request): Locale => {
  // cookie-parser types req.cookies as `any`.
  const cookies = req.cookies as Record<string, string | undefined>;
  const stored = cookies[LOCALE_COOKIE];

  return isSupported(stored) ? stored : negotiate(req.acceptsLanguages());
};

/**
 * Resolves the locale for a web request.
 *
 * In order: a supported `?lang=` is stored in the cookie and the request is
 * redirected without it, so shared and QR links stay clean; then the cookie;
 * then `Accept-Language`; then the base locale.
 *
 * The response body now depends on the cookie and on `Accept-Language`, so
 * both are declared in `Vary`, and the response is marked `private` unless a
 * stricter directive is already set: a shared cache must never serve one
 * visitor's language to another.
 */
export const localeMiddleware: RequestHandler = (req, res, next) => {
  if (!res.hasHeader('Cache-Control')) {
    res.setHeader('Cache-Control', 'private');
  }

  const requested = req.query.lang;

  if (
    (req.method === 'GET' || req.method === 'HEAD') &&
    isSupported(requested)
  ) {
    res.cookie(LOCALE_COOKIE, requested, COOKIE_OPTIONS);
    res.redirect(303, withoutQueryParam(req.originalUrl, 'lang'));
    return;
  }

  const locale = resolveLocale(req);

  res.locals.locale = locale;
  res.locals.dateLocale = dateTimeLocale(locale);
  res.locals.chrome = getMessages(locale, 'chrome');
  res.locals.localeLinks = localeLinks(req.originalUrl, locale);
  res.setHeader('Content-Language', locale);
  res.vary('Cookie');
  res.vary('Accept-Language');

  next();
};
