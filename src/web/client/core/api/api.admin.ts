import { request } from './api.request.ts';

import type { AdminScope } from '../../../../constants/admin-scopes.ts';

/**
 * The two admin screens' writes, each under its own namespace so calls read
 * `api.admin.attendees.create(...)` and `api.admin.lookup.markPresent(...)`,
 * and this module stays about identity.
 */
export * as attendees from './api.admin.attendees.ts';
export * as lookup from './api.admin.lookup.ts';
export * as metrics from './api.admin.metrics.ts';
export * as whatsapp from './api.admin.whatsapp.ts';
export * as whatsappDoor from './api.admin.whatsapp-door.ts';
export * as ticketLimit from './api.admin.ticket-limit.ts';
export * as survey from './api.admin.survey.ts';
export * as tshirts from './api.admin.tshirts.ts';
export * as pass from './api.admin.pass.ts';
export * as redemptions from './api.admin.redemptions.ts';
export * as volunteers from './api.admin.volunteers.ts';

/** Who the caller is, and what they may currently do. */
export interface AdminIdentity {
  username: string;
  scopes: AdminScope[];
}

/**
 * {@link AdminIdentity}, plus the on-screen label for each scope.
 *
 * `labels` is partial because it is a claim off the wire, not a guarantee: a
 * scope the server knows and this bundle does not would have no entry. The page
 * falls back to the scope's own name, which is ugly but true.
 */
export interface AdminIdentityView extends AdminIdentity {
  labels: Partial<Record<AdminScope, string>>;
}

/** The response envelope, with everything optional — see api.raffle.ts. */
interface Envelope<T> {
  data?: Partial<T>;
}

/**
 * Signs in.
 *
 * Every credential failure arrives as a 401 carrying one message, so there is
 * nothing here to branch on: the page shows what the server said. A spent
 * failure budget arrives as a 429 instead, which the page does distinguish,
 * because "wait" and "try again" are different instructions.
 *
 * @param username - Username as typed.
 * @param password - Password as typed.
 * @param captchaToken - The Turnstile token, when the widget produced one. Sent
 *   even as `undefined`, and absent is a case the server answers rather than one
 *   the page refuses: that is what lets the check be switched off at the origin
 *   when the widget itself is what has failed.
 */
export const login = async (
  username: string,
  password: string,
  captchaToken?: string,
): Promise<AdminIdentity> => {
  const res = await request<Envelope<AdminIdentity>>(
    '/api/v1/admin/auth/login',
    { method: 'POST', json: { username, password, captchaToken } },
  );

  const data = res.data;

  if (typeof data?.username !== 'string') {
    throw new Error('Login returned no identity');
  }

  return { username: data.username, scopes: data.scopes ?? [] };
};

/** Ends the session. */
export const logout = async (): Promise<void> => {
  await request('/api/v1/admin/logout', { method: 'POST' });
};

/**
 * Who the caller is.
 *
 * Read on every dashboard load rather than carried over from the sign-in
 * response, so the page reflects scopes as they are now — an administrator
 * narrowed while their tab sat open sees the change on their next visit rather
 * than at their next login.
 */
export const me = async (): Promise<AdminIdentityView> => {
  const res = await request<Envelope<AdminIdentityView>>('/api/v1/admin/me');

  const data = res.data;

  if (typeof data?.username !== 'string') {
    throw new Error('Identity lookup returned nothing');
  }

  return {
    username: data.username,
    scopes: data.scopes ?? [],
    labels: data.labels ?? {},
  };
};
