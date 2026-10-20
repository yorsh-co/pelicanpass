import type { SlideId } from '../../core/deck.ts';

/** One slide, built lazily so only the one on show touches the DOM. */
export interface Slide {
  id: SlideId;
  /** `cover` slides have no eyebrow or title block. */
  layout: 'cover' | 'content';
  /** Small uppercase section label above the title. */
  eyebrow: string | null;
  /** Title and accessible name. */
  title: string;
  /** One muted line under the title. */
  note: string | null;
  /** Creates the slide body; may register charts for `mountCharts`. */
  render: () => HTMLElement;
}
