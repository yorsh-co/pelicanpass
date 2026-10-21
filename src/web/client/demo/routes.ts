/**
 * Names the handler of every route, so this file stays plain data: `state.ts`
 * maps each name to its function, and the build reads the table without
 * pulling the browser types the handlers are written against.
 */
export type HandlerName =
  | 'submitTicket'
  | 'submitVerification'
  | 'submitQrCode'
  | 'checkPresence'
  | 'resetCheckin'
  | 'getPass'
  | 'getStatus'
  | 'setNickname'
  | 'logout'
  | 'submitSurvey'
  | 'getStaffBand'
  | 'verifyPass'
  | 'lookupAttendee'
  | 'redeemItem'
  | 'getDraws'
  | 'drawNumber'
  | 'resetDraw'
  | 'dropReport'
  | 'getMetricsSnapshot'
  | 'refuse';

/** One endpoint the mock answers. */
export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

  /**
   * The path under `/api/v1`. A trailing `/*` matches everything below it,
   * which is how a family of endpoints is refused without listing each one.
   */
  path: string;

  handler: HandlerName;
}

/**
 * Every `/api/v1` endpoint the shipped bundles call, and what answers it.
 *
 * Listed exactly, so the build can fail on a path the client gained and the
 * mock did not. The one family covered by a pattern is the administrator API,
 * every part of which is read-only in the demo apart from the metrics snapshot.
 * Exact entries are matched first.
 */
export const ROUTES: readonly Route[] = [
  { method: 'POST', path: '/api/v1/checkin/ticket', handler: 'submitTicket' },
  {
    method: 'POST',
    path: '/api/v1/checkin/verification',
    handler: 'submitVerification',
  },
  { method: 'POST', path: '/api/v1/checkin/qr', handler: 'submitQrCode' },
  {
    method: 'POST',
    path: '/api/v1/checkin/presence',
    handler: 'checkPresence',
  },
  { method: 'POST', path: '/api/v1/checkin/reset', handler: 'resetCheckin' },

  { method: 'GET', path: '/api/v1/attendee/pass', handler: 'getPass' },
  { method: 'GET', path: '/api/v1/attendee/status', handler: 'getStatus' },
  {
    method: 'PATCH',
    path: '/api/v1/attendee/nickname',
    handler: 'setNickname',
  },
  { method: 'POST', path: '/api/v1/attendee/logout', handler: 'logout' },

  { method: 'POST', path: '/api/v1/survey', handler: 'submitSurvey' },

  { method: 'GET', path: '/api/v1/staff/band', handler: 'getStaffBand' },
  { method: 'POST', path: '/api/v1/staff/verify', handler: 'verifyPass' },
  { method: 'POST', path: '/api/v1/staff/lookup', handler: 'lookupAttendee' },
  { method: 'POST', path: '/api/v1/staff/redeem', handler: 'redeemItem' },

  { method: 'GET', path: '/api/v1/raffle/draws', handler: 'getDraws' },
  { method: 'POST', path: '/api/v1/raffle/draw', handler: 'drawNumber' },
  { method: 'POST', path: '/api/v1/raffle/reset', handler: 'resetDraw' },

  { method: 'POST', path: '/api/v1/client-errors', handler: 'dropReport' },

  {
    method: 'GET',
    path: '/api/v1/admin/metrics/snapshot',
    handler: 'getMetricsSnapshot',
  },
  { method: 'GET', path: '/api/v1/admin/*', handler: 'refuse' },
  { method: 'POST', path: '/api/v1/admin/*', handler: 'refuse' },
  { method: 'PATCH', path: '/api/v1/admin/*', handler: 'refuse' },
  { method: 'PUT', path: '/api/v1/admin/*', handler: 'refuse' },
  { method: 'DELETE', path: '/api/v1/admin/*', handler: 'refuse' },
];

/** Whether `path` is the route's, exactly or under its trailing wildcard. */
const matches = (route: Route, path: string): boolean => {
  if (!route.path.endsWith('/*')) return path === route.path;

  const base = route.path.slice(0, -2);

  return path === base || path.startsWith(`${base}/`);
};

/**
 * Finds the route for a request.
 *
 * @param method - HTTP method, any case.
 * @param path - Request path without a query string.
 * @returns The route, or `undefined` for a path the mock does not know.
 */
export const findRoute = (method: string, path: string): Route | undefined => {
  const upper = method.toUpperCase();
  const candidates = ROUTES.filter(
    (route) => route.method === upper && matches(route, path),
  );

  return (
    candidates.find((route) => !route.path.endsWith('/*')) ?? candidates[0]
  );
};

/**
 * Whether any route answers `path`, under any method.
 *
 * What the build's coverage check uses: it finds paths in the shipped bundles
 * but not the methods they are called with.
 *
 * @param path - A path from the bundles, with `${…}` segments already
 *   replaced by `*`.
 */
export const isCovered = (path: string): boolean =>
  ROUTES.some((route) => matches(route, path));
