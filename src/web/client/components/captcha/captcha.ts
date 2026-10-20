/**
 * Callbacks a caller can hand to {@link TurnstileCaptcha}.
 *
 * Named for what they mean here rather than for Turnstile's kebab-case option
 * keys; {@link TurnstileCaptcha.render} does the translation.
 */
export interface TurnstileCaptchaOptions {
  /** Turnstile `action` label, used to segment analytics per widget. */
  action?: string;

  /** Receives the token once the challenge is solved. */
  successCallback?: (token: string) => void;

  errorCallback?: () => void;
  expiredCallback?: () => void;
  timeoutCallback?: () => void;
}

/**
 * Wraps a Cloudflare Turnstile widget bound to one container element.
 *
 * The site key is read off the container's `data-sitekey`, which the EJS
 * template renders from `env.captcha.siteKey`.
 */
export class TurnstileCaptcha {
  readonly el: HTMLElement;
  readonly sitekey: string;
  readonly options: TurnstileCaptchaOptions;

  /** Set while a widget is mounted, cleared by {@link remove}. */
  widgetId: string | undefined;

  isRendered: boolean;

  /**
   * @param captchaDiv - Container the widget mounts into.
   * @param options - Callbacks and the action label.
   * @throws {Error} If the container carries no `data-sitekey`.
   */
  constructor(captchaDiv: HTMLElement, options: TurnstileCaptchaOptions = {}) {
    this.el = captchaDiv;

    const { sitekey } = captchaDiv.dataset;

    if (!sitekey) throw new Error('[TurnstileCaptcha] missing siteKey');

    this.sitekey = sitekey;

    this.options = options;

    this.widgetId = undefined;
    this.isRendered = false;
  }

  /** Mounts the widget, replacing any previously rendered one. */
  render(): void {
    const {
      action,
      successCallback,
      errorCallback,
      expiredCallback,
      timeoutCallback,
    } = this.options;

    const options: TurnstileRenderOptions = {
      sitekey: this.sitekey,
      size: 'flexible',
      appearance: 'always',
    };

    // Assigned rather than spread: exactOptionalPropertyTypes means an absent
    // callback and one explicitly set to undefined are different types.
    if (action) options.action = action;
    if (successCallback) options.callback = successCallback;
    if (errorCallback) options['error-callback'] = errorCallback;
    if (expiredCallback) options['expired-callback'] = expiredCallback;
    if (timeoutCallback) options['timeout-callback'] = timeoutCallback;

    this.widgetId = turnstile.render(this.el, options);
  }

  /** The current token, or `undefined` before the challenge is solved. */
  getToken(): string | undefined {
    return turnstile.getResponse(this.widgetId);
  }

  reset(): void {
    turnstile.reset(this.widgetId);
  }

  /** Unmounts the widget and forgets its id. */
  remove(): void {
    turnstile.remove(this.widgetId);

    this.widgetId = undefined;
  }

  isExpired(): boolean {
    return turnstile.isExpired(this.widgetId);
  }
}
