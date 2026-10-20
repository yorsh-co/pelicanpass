import { ageBandOf } from '../core/age.ts';
import { ages } from './ages.ts';
import { churches } from './churches.ts';
import { el } from './dom.ts';

import type { Attendee } from '../core/checkin.ts';
import type { Ctx } from './ctx.ts';

/**
 * Tells which profile data the participants carry.
 *
 * @param attendees - Every row of the export.
 */
export const profileData = (
  attendees: readonly Attendee[],
): { church: boolean; age: boolean } => {
  const participants = attendees.filter(
    (a) => !a.archived && a.role === 'participant',
  );

  return {
    church: participants.some((a) => a.church !== null),
    age: participants.some((a) => ageBandOf(a) !== null),
  };
};

/** The "Perfil" tab: participants by church and by age, where known. */
export const profile = (ctx: Ctx): HTMLElement => {
  const has = profileData(ctx.data.attendees);
  const section = (title: string, body: HTMLElement | null) =>
    body &&
    el(
      'section',
      { class: 'audience' },
      el('h2', { class: 'section-title' }, title),
      body,
    );

  return el(
    'div',
    { class: 'stack' },
    section('Igrejas', has.church ? churches(ctx) : null),
    section('Faixa etária', has.age ? ages(ctx) : null),
  );
};
