import type { Request } from 'express';

import { hashUA } from '../../shared/utils/hash.ts';

import type { AdminSession } from '../../types/session.ts';

/**
 * Builds the initial state of an administrator session.
 *
 * @param req - Request the session is being issued for.
 * @returns A complete {@link AdminSession}.
 */
export const createAdminSession = (req: Request): AdminSession => ({
  type: 'admin',

  version: 1,

  // Seeded by AdminService.login through the adapter's overrides, which is the
  // only thing that may create one of these.
  adminId: null,
  username: null,

  ua: hashUA(req.headers['user-agent']),

  // Overwritten by session.service.ts on create and on every save; set here
  // only so the factory returns a complete AdminSession.
  updatedAt: Date.now(),
  createdAt: Date.now(),
});
