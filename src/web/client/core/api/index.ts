import * as checkin from './api.checkin.ts';
import * as attendee from './api.attendee.ts';
import * as staff from './api.staff.ts';
import * as raffle from './api.raffle.ts';
import * as admin from './api.admin.ts';
import * as survey from './api.survey.ts';

/** Single import surface for the backend API, grouped by router. */
const api = {
  checkin,
  attendee,
  staff,
  raffle,
  admin,
  survey,
};

export default api;
