import { ticketPrefixKind } from '../../constants/ticket.ts';

import type { AdminMetricsMessages } from '../../i18n/generated/admin-metrics.messages.ts';
import type { LimiterKeyBasis, LimiterPurpose } from '../../types/limiter.ts';
import type { LatencyGroup } from './metrics.service.ts';

/**
 * Names for the codes the snapshot carries, for the panel's server render.
 *
 * The snapshot sends limiter and latency codes rather than prose, so the API
 * stays language-free; the page names them in the response's locale. Only the
 * server needs these: the limiter tooltips and the latency row headers are
 * rendered once and never rewritten by the polling script. Each map is total,
 * so a new limiter or latency group cannot ship unnamed.
 *
 * @param m - `admin-metrics` in the response's locale.
 */
export const metricsLabels = (m: AdminMetricsMessages) => ({
  keyedOn: {
    ip: m.limiterKeyedOnIp(),
    ipStrict: m.limiterKeyedOnIpStrict(),
    ipTrusted: m.limiterKeyedOnIpTrusted(),
    checkinSession: m.limiterKeyedOnCheckinSession(),
    attendeeSession: m.limiterKeyedOnAttendeeSession(),
    adminSession: m.limiterKeyedOnAdminSession(),
    checkinCookie: m.limiterKeyedOnCheckinCookie(),
    volunteerSession: m.limiterKeyedOnVolunteerSession(),
    global: m.limiterKeyedOnGlobal(),
    adminUsername: m.limiterKeyedOnAdminUsername(),
    verifiedAttendee: m.limiterKeyedOnVerifiedAttendee(),
    lookupVolunteer: m.limiterKeyedOnLookupVolunteer(),
    admin: m.limiterKeyedOnAdmin(),
  } satisfies Record<LimiterKeyBasis, string>,

  protects: {
    api: m.limiterProtectsApi(),
    web: m.limiterProtectsWeb(),
    checkinSessionRoutes: m.limiterProtectsCheckinSessionRoutes(),
    attendeeSessionRoutes: m.limiterProtectsAttendeeSessionRoutes(),
    adminSessionRoutes: m.limiterProtectsAdminSessionRoutes(),
    checkinCreation: m.limiterProtectsCheckinCreation(),
    staffCounters: m.limiterProtectsStaffCounters(),
    metricsPanel: m.limiterProtectsMetricsPanel(),
    redemptionsPanel: m.limiterProtectsRedemptionsPanel(),
    whatsappSender: m.limiterProtectsWhatsappSender(),
    clientErrorsIp: m.limiterProtectsClientErrorsIp(),
    clientErrorsGlobal: m.limiterProtectsClientErrorsGlobal(),
    whatsappWebhookIp: m.limiterProtectsWhatsappWebhookIp(),
    whatsappWebhookGlobal: m.limiterProtectsWhatsappWebhookGlobal(),
    adminLogin: m.limiterProtectsAdminLogin(),
    adminLoginFailures: m.limiterProtectsAdminLoginFailures(),
    checkinEntry: m.limiterProtectsCheckinEntry(),
    checkinEntryFailures: m.limiterProtectsCheckinEntryFailures(),
    verificationFailures: m.limiterProtectsVerificationFailures(),
    lookupFailures: m.limiterProtectsLookupFailures(),
    whatsappDoor: m.limiterProtectsWhatsappDoor(),
  } satisfies Record<LimiterPurpose, string>,

  latency: {
    checkin: m.latencyGroupCheckinPages(),
    'api.checkin': m.latencyGroupCheckinApi(),
    staff: m.latencyGroupStaffPages(),
    'api.staff': m.latencyGroupStaffApi(),
  } satisfies Record<LatencyGroup, string>,

  /** Row label for a participant's one-character ticket key. */
  checkinPrefix: (prefix: string): string =>
    m.doorPrefix({ kind: ticketPrefixKind(prefix), prefix }),
});
