import { el } from '../dom.ts';
import { slideFrame } from './frame.ts';
import { paginate } from '../../core/paginate.ts';

import type { Ctx } from '../ctx.ts';
import type { BlockExtent } from '../../core/paginate.ts';

/** Title of the feedback summary slides. */
export const RESUMO_TITLE = 'Resumo do feedback';

/** Eyebrow of the feedback summary slides. */
export const RESUMO_EYEBROW = 'Feedback';

/** Slack kept free at the foot of a page, against sub-pixel rounding. */
const SAFETY = 8;

const isHeading = (block: Element): boolean => /^H[1-3]$/.test(block.tagName);

/**
 * Splits the reviewed summary into slide-sized pages.
 *
 * The blocks are laid out in an off-screen slide body with the same CSS as the
 * real one, measured, and packed by {@link paginate}. `html` is trusted
 * build-time markup, never CSV text.
 *
 * @param ctx - Report context, for the frame.
 * @param html - Rendered summary.
 * @returns The top-level blocks of each page.
 */
export const resumoPages = (ctx: Ctx, html: string): HTMLElement[][] => {
  const template = document.createElement('template');

  template.innerHTML = html;
  const blocks = [...template.content.children].filter(
    (node): node is HTMLElement => node instanceof HTMLElement,
  );
  const prose = el('div', { class: 'pprose' }, ...blocks);
  const probe = el(
    'div',
    { class: 'pmeasure', attrs: { 'aria-hidden': 'true' } },
    slideFrame(
      ctx,
      {
        id: 'resumo',
        layout: 'content',
        eyebrow: 'Feedback',
        title: `${RESUMO_TITLE} (1/1)`,
        note: null,
      },
      prose,
      0,
      1,
    ),
  );

  document.body.append(probe);
  const body = prose.parentElement;
  const capacity = (body?.clientHeight ?? 0) - SAFETY;
  const extents = blocks.map((block): BlockExtent => {
    const box = block.getBoundingClientRect();

    return { top: box.top, bottom: box.bottom, heading: isHeading(block) };
  });

  probe.remove();

  return paginate(extents, capacity).map((page) =>
    page.flatMap((i) => blocks[i] ?? []),
  );
};
