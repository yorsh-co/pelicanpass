/**
 * The demo's stand-in for the backend, loaded before any page script.
 *
 * It replaces `window.fetch` for same-origin `/api/v1` requests and the
 * `/readyz` probe, so the real client runs unchanged against `./state.ts`, and
 * replaces `navigator.sendBeacon` for the error reporter. Everything else
 * passes through to the network. Administrator forms are cancelled with a
 * notice by `./admin-guard.ts`, which is why the screens are read-only.
 *
 * It also does the two things the server did around the page: it writes the
 * visitor's check-in or pass into the data tag the page script reads, and it
 * sends the visitor to the page their session belongs on. State lives in
 * `sessionStorage`, one event per tab, with an in-memory copy for when storage
 * is unavailable.
 *
 * Bundled by `scripts/demo/build.ts` as a classic script; production never
 * includes it.
 */

import { installAdminGuard, showNotice } from './admin-guard.ts';
import { applyBannerLanguage, bindBannerLanguage } from './banner-language.ts';
import { applyBannerState, bindBannerToggle } from './banner-state.ts';
import { metricsSnapshot } from './metrics-snapshot.ts';
import { findRoute } from './routes.ts';
import {
  HANDLERS,
  checkinPageData,
  createInitialState,
  passPageData,
  sessionRole,
} from './state.ts';

import type { DemoRequest, DemoResult, DemoState } from './state.ts';

/** Where the state is kept; bumped with {@link DemoState.version}. */
const STORAGE_KEY = 'pelicanpass-demo:v1';

const API_PREFIX = '/api/v1/';
const REPORT_PATH = '/api/v1/client-errors';
const LOGOUT_PATH = '/api/v1/admin/logout';

/** The readiness probe the metrics dashboard asks outside `/api/v1`. */
const READYZ_PATH = '/readyz';

/** The range of simulated network latency, in milliseconds. */
const LATENCY_MIN_MS = 150;
const LATENCY_MAX_MS = 400;

/** How long after a refusal its notice is shown; the client reads the body first. */
const NOTICE_DELAY_MS = 100;

/** Last state this page wrote or read, for when storage is unavailable. */
let memory: DemoState | undefined;

/** Whether parsed JSON has the shape of the current state. */
const isState = (value: unknown): value is DemoState =>
  typeof value === 'object' &&
  value !== null &&
  (value as { version?: unknown }).version === 1 &&
  typeof (value as { records?: unknown }).records === 'object' &&
  typeof (value as { checkin?: unknown }).checkin === 'object';

/** The current state, from storage, memory or a fresh start. */
const load = (): DemoState => {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);

    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);

      if (isState(parsed)) {
        memory = parsed;

        return parsed;
      }
    }
  } catch {
    // Storage is blocked or the value is not JSON: fall through.
  }

  memory ??= createInitialState(Date.now());

  return memory;
};

const save = (state: DemoState): void => {
  memory = state;

  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // The in-memory copy still serves this page.
  }
};

/** Forgets everything; the next load starts a new event. */
const clear = (): void => {
  memory = undefined;

  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored to remove.
  }
};

/** The rejection `fetch` produces when its signal aborts. */
const abortError = (signal: AbortSignal): Error =>
  signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');

/** A latency in the simulated range. */
const latency = (): number =>
  LATENCY_MIN_MS + Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS);

/** Resolves after the simulated latency, or rejects if the signal aborts. */
const delay = (signal: AbortSignal | null | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!signal) {
      window.setTimeout(resolve, latency());

      return;
    }

    if (signal.aborted) {
      reject(abortError(signal));

      return;
    }

    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(abortError(signal));
    };

    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, latency());

    signal.addEventListener('abort', onAbort, { once: true });
  });

const toResponse = ({ status, body }: DemoResult): Response =>
  body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

/** Reads a request body the client sent as JSON; anything else is no body. */
const parseBody = (body: BodyInit | null | undefined): unknown => {
  if (typeof body !== 'string') return undefined;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

const headerRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};

  headers.forEach((value, name) => {
    record[name.toLowerCase()] = value;
  });

  return record;
};

/** The path of a same-origin `/api/v1` request, or `null` for anything else. */
const apiPath = (input: RequestInfo | URL): URL | null => {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const url = new URL(raw, window.location.href);

  return url.origin === window.location.origin &&
    url.pathname.startsWith(API_PREFIX)
    ? url
    : null;
};

/** Answers one API request from the state, after the simulated latency. */
const answer = async (
  url: URL,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<Response> => {
  const source = input instanceof Request ? input : undefined;
  const signal = init?.signal ?? source?.signal;

  if (signal?.aborted) throw abortError(signal);

  const method = (init?.method ?? source?.method ?? 'GET').toUpperCase();
  const route = findRoute(method, url.pathname);
  const request: DemoRequest = {
    body: parseBody(init?.body),
    headers: headerRecord(new Headers(init?.headers ?? source?.headers)),
    now: Date.now(),
    random: Math.random,
    uuid: () => window.crypto.randomUUID(),
  };

  // Applied before the wait, as the server commits whether or not the client
  // is still listening when it finishes.
  const result: DemoResult = route
    ? HANDLERS[route.handler](load(), request)
    : {
        state: load(),
        status: 404,
        body: {
          success: false,
          error: 'Resource not found',
          code: 'NOT_FOUND',
        },
      };

  save(result.state);

  await delay(signal);

  // Once the page has handled the response, so the notice replaces whatever
  // generic failure toast the screen showed instead of being replaced by it.
  // Reads are refused silently: the dashboards poll them. Signing out leaves
  // the page on its own.
  if (
    route?.handler === 'refuse' &&
    method !== 'GET' &&
    url.pathname !== LOGOUT_PATH
  ) {
    window.setTimeout(() => {
      void showNotice('disabled');
    }, NOTICE_DELAY_MS);
  }

  return toResponse(result);
};

/** Answers the readiness probe: both dependencies up, as the demo claims. */
const readiness = async (init: RequestInit | undefined): Promise<Response> => {
  await delay(init?.signal);

  return toResponse({
    state: load(),
    status: 200,
    body: {
      status: 'ready',
      release: 'demo',
      dependencies: metricsSnapshot(Date.now()).health,
    },
  });
};

/** Whether the request is for the readiness probe. */
const isReadyz = (input: RequestInfo | URL): boolean => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.href,
  );

  return url.origin === window.location.origin && url.pathname === READYZ_PATH;
};

const installFetch = (): void => {
  const original = window.fetch.bind(window);

  window.fetch = (input, init) => {
    const url = apiPath(input);

    if (url) return answer(url, input, init);

    return isReadyz(input) ? readiness(init) : original(input, init);
  };
};

const installBeacon = (): void => {
  const original =
    typeof navigator.sendBeacon === 'function'
      ? navigator.sendBeacon.bind(navigator)
      : undefined;

  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: (url: string | URL, data?: BodyInit | null): boolean => {
      if (new URL(url, window.location.href).pathname === REPORT_PATH) {
        return true;
      }

      return original ? original(url, data) : false;
    },
  });
};

/** Where each page of an attendee session lives. */
const PASS_PATHS = {
  participant: '/pass',
  volunteer: '/pass-volunteer',
} as const;

/**
 * Sends the visitor where the server would have: a checked-in attendee off the
 * check-in page and onto their pass, and a visitor with no session off a pass.
 * The pass has two files, one per role, because the pass page renders a
 * volunteer's team line on the server.
 */
const routeSession = (): void => {
  const path = window.location.pathname.replace(/(?:\.html)?\/?$/, '') || '/';
  const role = sessionRole(load());
  const home = role === null ? '/checkin' : PASS_PATHS[role];
  const passes: string[] = Object.values(PASS_PATHS);

  if (
    path === '/checkin' ? role !== null : passes.includes(path) && path !== home
  ) {
    window.location.replace(home);
  }
};

/** Replaces the JSON the server would have written into a page's data tag. */
const seedData = (id: string, data: unknown): void => {
  const tag = document.getElementById(id);

  if (tag && data !== null) tag.textContent = JSON.stringify(data);
};

/** Writes the visitor's state into the page, before its scripts run. */
const seedPage = (): void => {
  const state = load();

  seedData('checkin-data', checkinPageData(state));
  seedData('attendee-data', passPageData(state, Date.now()));
};

/**
 * Binds the banner's reset buttons, which the build renders hidden, one per
 * language. The language choice lives in `localStorage`, so it survives a reset.
 */
const bindReset = (): void => {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    '[data-demo-reset]',
  )) {
    button.hidden = false;
    button.addEventListener('click', () => {
      clear();
      window.location.assign('/checkin');
    });
  }
};

installFetch();
installBeacon();
installAdminGuard();
applyBannerLanguage();
applyBannerState();
routeSession();

// `interactive` is announced before deferred and module scripts run, which is
// the last moment the page's data tags can be replaced.
const onReady = (): void => {
  seedPage();
  bindReset();
  bindBannerLanguage();
  bindBannerToggle();
};

if (document.readyState === 'loading') {
  document.addEventListener('readystatechange', () => {
    if (document.readyState === 'interactive') onReady();
  });
} else {
  onReady();
}
