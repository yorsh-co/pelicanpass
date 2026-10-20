import type { RedemptionItem } from '../../../../constants/pass.ts';
import type { AdminRefusal } from '../../../../types/admin-refusal.ts';
import type { AppErrorCode } from '../../../../types/appErrorCode.ts';
import type { CheckinStep } from '../../../../types/checkin.ts';

/**
 * Error codes this client can see: every code the backend emits, plus the
 * fallback used when a response carries no code at all.
 *
 * `AppErrorCode` is imported from the backend rather than re-declared here.
 * The code is serialised into the error response, so the two halves are
 * describing one contract, and a type-only import erases before the bundler
 * ever sees it.
 *
 * `EDGE_CHALLENGE` is the exception, and is deliberately *not* in
 * `AppErrorCode`: it names a response the origin never produced and never sees
 * — Cloudflare answers it at the edge — so putting it in the shared union would
 * describe a contract the backend cannot honour.
 *
 * `EDGE_UNREACHABLE` is there for the same reason and names the other half of
 * that surface: a request that never completed at all. An expired Cloudflare
 * Access session answers with a redirect to the team domain, cross-origin and
 * without CORS headers, so `fetch` rejects rather than returning — and a phone
 * losing signal is indistinguishable from it here. Naming it lets the one place
 * that calls `fetch` decide what to do, instead of a bare `TypeError` escaping to
 * the global handler as though it were a defect.
 *
 * `EDGE_TIMEOUT` is the client giving up: nothing answered within the request's
 * deadline. Unlike the two above, the request may well have reached the origin,
 * and a mutation may have committed after the client stopped waiting.
 */
export type ApiErrorCode =
  | AppErrorCode
  | 'UNKNOWN_ERROR'
  | 'EDGE_CHALLENGE'
  | 'EDGE_UNREACHABLE'
  | 'EDGE_TIMEOUT';

/**
 * Machine-readable context on an error response.
 *
 * Mirrors `AppErrorDetails` in `src/shared/errors/app-error.ts`, which cannot
 * be imported directly because that module also carries runtime code that
 * would not type-check against the browser lib.
 */
export interface ApiErrorDetails {
  /** Seconds the caller must wait before retrying. */
  retryAfterSeconds?: number | undefined;

  /** Step to resume at once the captcha clears. */
  nextStep?: CheckinStep | undefined;

  /** Whether the client must render a captcha. */
  captchaRequired?: boolean | undefined;

  /** Admin refusals: which one, since a single code covers several. */
  reason?: AdminRefusal | undefined;

  /** Admin refusals: the item a refusal is about, where it names one. */
  item?: RedemptionItem | undefined;
}

/** Constructor options for {@link ApiError}. */
export interface ApiErrorOptions {
  status?: number | undefined;
  code?: ApiErrorCode | undefined;
  details?: ApiErrorDetails | undefined;
}

/**
 * Error thrown by the API request helper when the server responds
 * with a non-2xx status. Mirrors the backend AppError JSON shape so
 * callers can branch on `code` instead of matching message strings.
 */
export class ApiError extends Error {
  readonly status: number | undefined;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetails | undefined;

  constructor(message: string, options: ApiErrorOptions = {}) {
    const { status, code = 'UNKNOWN_ERROR', details } = options;

    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
