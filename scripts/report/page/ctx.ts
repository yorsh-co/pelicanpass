import type { Attendee } from '../core/checkin.ts';
import type { Filters } from '../core/filter.ts';
import type { Definitions } from '../core/model.ts';
import type { Palette } from './theme.ts';
import type { Loaded } from './state.ts';

type Role = Attendee['role'];

/** What a tab needs to draw itself. */
export interface Ctx {
  data: Loaded;
  definitions: Definitions;
  /** Host church of the event; `null` when there is none. */
  hostChurch: string | null;
  filters: Filters;
  /** Registrations after the filters. */
  rows: Attendee[];
  /** Roles that contribute to the attendance views. */
  roles: Role[];
  palette: Palette;
}
