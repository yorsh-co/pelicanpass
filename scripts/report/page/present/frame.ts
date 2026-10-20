import { COPY_DEFAULTS } from '../../../../src/constants/copy-defaults.ts';
import { byChurch } from '../../core/metrics.ts';
import { filterSummary } from '../../core/deck.ts';
import { el } from '../dom.ts';

import type { Ctx } from '../ctx.ts';
import type { Slide } from './types.ts';

/** Label of the left footer cell. */
const EVENT_NAME = COPY_DEFAULTS.eventName;

/**
 * Wraps a slide body in the common frame: eyebrow, title, note and footer.
 *
 * @param ctx - Report context, for the filters and sample flag.
 * @param slide - The slide's metadata.
 * @param body - The slide's content.
 * @param index - Zero-based position in the deck.
 * @param count - Slides in the deck.
 */
export const slideFrame = (
  ctx: Ctx,
  slide: Pick<Slide, 'id' | 'layout' | 'eyebrow' | 'title' | 'note'>,
  body: HTMLElement,
  index: number,
  count: number,
): HTMLElement => {
  const centre = [
    filterSummary(
      ctx.filters,
      byChurch(ctx.data.attendees).map((c) => c.church),
    ),
    ctx.data.sample ? 'Dados de exemplo' : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  return el(
    'section',
    {
      class: `pslide pslide--${slide.id}`,
      attrs: {
        'aria-label': `Slide ${String(index + 1)} de ${String(count)}: ${slide.title}`,
      },
    },
    slide.layout === 'cover'
      ? null
      : el(
          'header',
          { class: 'pslide-head' },
          slide.eyebrow === null
            ? null
            : el('p', { class: 'pslide-eyebrow' }, slide.eyebrow),
          el('h2', { class: 'pslide-title' }, slide.title),
          slide.note === null
            ? null
            : el('p', { class: 'pslide-note' }, slide.note),
        ),
    el('div', { class: 'pslide-body' }, body),
    el(
      'footer',
      { class: 'pslide-foot' },
      el('span', {}, EVENT_NAME),
      el('span', { class: 'pslide-foot-centre' }, centre),
      el(
        'span',
        { class: 'pslide-foot-end' },
        `${String(index + 1)} / ${String(count)}`,
      ),
    ),
  );
};
