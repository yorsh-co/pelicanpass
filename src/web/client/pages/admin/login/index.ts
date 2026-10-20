import api from '../../../core/api/index.ts';
import { ApiError } from '../../../core/api/api.error.ts';
import { TurnstileCaptcha } from '../../../components/captcha/captcha.ts';
import { qs } from '../../../layouts/main/dom.ts';
import { logger } from '../../../modules/log/logger.ts';
import { LOGIN_COPY } from './messages.ts';

/**
 * The administrator sign-in form.
 *
 * Imports `qs` on its own rather than the layout's `dom` default: that module
 * resolves the boot screen and the footer logout button at import time, and
 * this page is served through `layouts/plain`, which has neither.
 */

/** `[data-admin="…"]`, resolved with the shared throwing selector. */
const slot = (name: string) => `[data-admin="${name}"]`;

const dom = Object.freeze({
  form: qs<HTMLFormElement>(slot('form')),
  username: qs<HTMLInputElement>(slot('username')),
  password: qs<HTMLInputElement>(slot('password')),
  reveal: qs<HTMLButtonElement>(slot('reveal')),
  revealIcon: qs(`${slot('reveal')} > .material-symbols-outlined`),
  submit: qs<HTMLButtonElement>(slot('submit')),
  error: qs(slot('error')),
  captcha: qs(slot('captcha')),
});

const captcha = new TurnstileCaptcha(dom.captcha, { action: 'admin-login' });

/**
 * Mounts the widget, unless the Turnstile script never arrived.
 *
 * `render()` reaches for the global that script defines, so a blocked or slow
 * `challenges.cloudflare.com` would throw a `ReferenceError` here and take the
 * submit handler below with it — turning a cosmetic failure into a form that
 * cannot be used at all. Guarded, the page keeps working and sends no token; the
 * server decides what that means, which is what makes
 * `TURNSTILE_ADMIN_ENFORCE=false` able to rescue exactly this case.
 */
const mountCaptcha = (): void => {
  if (typeof turnstile === 'undefined') {
    logger.error('admin', 'Turnstile script unavailable');

    return;
  }

  captcha.render();
};

/**
 * The solved token, or `undefined` when there is nothing to read.
 *
 * Guarded on `widgetId` rather than calling straight through: that field is only
 * set by a successful `render()`, so it is also the test for whether the
 * Turnstile global exists at all — `getToken()` would otherwise throw the same
 * `ReferenceError` {@link mountCaptcha} exists to avoid, one step later.
 */
const token = (): string | undefined =>
  captcha.widgetId ? captcha.getToken() : undefined;

/**
 * Turns a failure into the one sentence the form shows.
 *
 * A spent budget is told apart from a bad credential deliberately: they call
 * for different actions, and the server has already decided that saying so is
 * safe — the budget is keyed on the username, so the message reveals nothing a
 * caller who typed that name does not already know.
 *
 * Everything else collapses to one message. The server refuses an unknown
 * username, a wrong password and a deactivated account identically, and the
 * page must not invent a distinction the API took care not to make.
 */
const messageFor = (err: unknown): string => {
  if (!(err instanceof ApiError)) return LOGIN_COPY.offline;

  if (err.code === 'RATE_LIMITED') {
    const seconds = err.details?.retryAfterSeconds;

    if (typeof seconds !== 'number') return LOGIN_COPY.blocked;

    return LOGIN_COPY.blockedFor(Math.ceil(seconds / 60));
  }

  if (err.code === 'UNAUTHORIZED') return LOGIN_COPY.failed;

  if (err.code === 'CAPTCHA_REQUIRED') return LOGIN_COPY.captchaRequired;

  return LOGIN_COPY.offline;
};

/**
 * Shows or masks the typed password.
 *
 * Only the state and the icon change; the button's accessible name is fixed in
 * the view and `aria-pressed` carries whether the password is showing.
 */
const setRevealed = (on: boolean): void => {
  dom.password.type = on ? 'text' : 'password';
  dom.reveal.setAttribute('aria-pressed', String(on));
  /* copy-ok: icon ligature */
  dom.revealIcon.textContent = on ? 'visibility_off' : 'visibility';
};

let submitting = false;

/**
 * Signs in and hands the browser to the dashboard.
 *
 * A full navigation rather than a client-side transition: the session cookie is
 * what `/admin` is gated on, and letting the browser make an ordinary request
 * for the page means the server renders it having already seen the cookie.
 */
const submit = async (event: SubmitEvent): Promise<void> => {
  event.preventDefault();

  if (submitting) return;

  // Masked before sending: password managers offer to save only from a
  // password field, and a refused attempt must not leave the retry in clear.
  setRevealed(false);

  const username = dom.username.value.trim();
  const password = dom.password.value;

  if (!username || !password) {
    dom.error.textContent = LOGIN_COPY.failed;
    return;
  }

  submitting = true;
  dom.submit.disabled = true;
  dom.error.textContent = '';

  try {
    // Sent whatever it is. An absent token is not refused here: the server is
    // the only place that knows whether the check is being enforced, and a page
    // that turned the submit away would make that switch unreachable on the one
    // night it matters.
    await api.admin.login(username, password, token());

    window.location.assign('/admin');
  } catch (err) {
    dom.error.textContent = messageFor(err);

    // Reset on every failure, not only on CAPTCHA_REQUIRED. The middleware
    // validates the token before the password is checked, so a wrong password —
    // the common failure on a sign-in form — leaves a spent token in the widget.
    // Without this the second attempt is refused for a reason the volunteer has
    // no way to read.
    if (captcha.widgetId) captcha.reset();

    // Cleared on failure only. On success the browser is leaving the page, and
    // blanking the field first would flash an empty form on a slow navigation.
    dom.password.value = '';
    dom.password.focus();

    logger.warn('admin', 'Sign-in refused');
  } finally {
    submitting = false;
    dom.submit.disabled = false;
  }
};

dom.form.addEventListener('submit', (event) => {
  void submit(event);
});

dom.reveal.addEventListener('click', () => {
  setRevealed(dom.password.type === 'password');

  // Back to the field so the keyboard stays up on a phone.
  dom.password.focus();
});

mountCaptcha();

dom.username.focus();
