import { logger } from '../../shared/logger/logger.ts';

/** Per-call options accepted by {@link TurnstileValidator.validate}. */
export interface TurnstileValidateOptions {
  /** Client IP, forwarded to Turnstile as `remoteip`. */
  remoteIp?: string | undefined;

  /** Makes a retried verification of the same token idempotent. */
  idempotencyKey?: string | undefined;

  /** Rejects the token unless the widget reported this action. */
  expectedAction?: string | undefined;

  /** Rejects the token unless the widget reported this hostname. */
  expectedHostname?: string | undefined;
}

/** Request body accepted by the Turnstile siteverify endpoint. */
interface SiteverifyRequestBody {
  secret: string;
  response: string;
  remoteip?: string;
  idempotency_key?: string;
}

/** The parts of the siteverify response this service reads. */
interface SiteverifyResponse {
  success: boolean;
  action?: string;
  hostname?: string;
}

/** Outcome of a validation attempt. */
export interface TurnstileValidationResult {
  success: boolean;

  /** Why validation failed; absent on success. */
  error?: string | undefined;

  /** On an action or hostname mismatch, the value that was required. */
  expected?: string | undefined;

  /** On an action or hostname mismatch, the value Turnstile reported. */
  received?: string | undefined;
}

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Longest token Turnstile will issue, per its documentation. */
const MAX_TOKEN_LENGTH = 2048;

/** Verifies Cloudflare Turnstile tokens against the siteverify endpoint. */
export class TurnstileValidator {
  private readonly secretKey: string;
  private readonly timeout: number;

  /**
   * @param secretKey - Turnstile secret for this site.
   * @param timeout - Milliseconds to wait for siteverify before giving up.
   */
  constructor(secretKey: string, timeout = 10000) {
    this.secretKey = secretKey;
    this.timeout = timeout;
  }

  /**
   * Validates a token submitted by the browser.
   *
   * Never throws: a malformed token, a network failure and a timeout all come
   * back as an unsuccessful result, so callers can treat "invalid" and
   * "unverifiable" the same way.
   *
   * @param token - Value the Turnstile widget put in the request body. Typed
   *   as `unknown` because it arrives unvalidated from the client.
   * @param options - Per-call verification options.
   */
  async validate(
    token: unknown,
    options: TurnstileValidateOptions = {},
  ): Promise<TurnstileValidationResult> {
    if (!token || typeof token !== 'string') {
      return { success: false, error: 'Invalid token format' };
    }

    if (token.length > MAX_TOKEN_LENGTH) {
      return { success: false, error: 'Token too long' };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, this.timeout);

    try {
      const body: SiteverifyRequestBody = {
        secret: this.secretKey,
        response: token,
      };

      if (options.remoteIp) body.remoteip = options.remoteIp;

      if (options.idempotencyKey) {
        body.idempotency_key = options.idempotencyKey;
      }

      const response = await fetch(SITEVERIFY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // siteverify is not self-describing, so its JSON is asserted rather
      // than parsed; only `success`, `action` and `hostname` are read.
      const result = (await response.json()) as SiteverifyResponse;

      if (result.success) {
        if (
          options.expectedAction &&
          result.action !== options.expectedAction
        ) {
          return {
            success: false,
            error: 'Action mismatch',
            expected: options.expectedAction,
            received: result.action,
          };
        }

        if (
          options.expectedHostname &&
          result.hostname !== options.expectedHostname
        ) {
          return {
            success: false,
            error: 'Hostname mismatch',
            expected: options.expectedHostname,
            received: result.hostname,
          };
        }
      }

      return result;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: 'Validation timeout' };
      }

      logger.error({ err }, 'Turnstile validation error');

      return { success: false, error: 'Internal error' };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
