import { readFileSync } from 'node:fs';

import { marked } from 'marked';

import {
  REDEEMABLE_ITEMS,
  isRedemptionItem,
  isVolunteerOnlyItem,
} from '../../constants/pass.ts';

import type { Token, Tokens } from 'marked';

import type { RedemptionItem } from '../../constants/pass.ts';
import type { AttendeeRole } from '../../types/attendee.ts';

/**
 * The approved options for each redemption item, read from
 * `src/web/content/redemption-options.md`.
 *
 * Markdown on the survey's precedent, so the list can be edited without
 * touching code. An item's options may be scoped by attendee role with
 * `### participant` and `### volunteer` subsections; an untagged list applies
 * to both. The grammar and the editing rules are in
 * `docs/features/redemption-options.md`.
 *
 * Parsed once, when this module is first imported: the file ships inside the
 * image and cannot change under a running process. Every problem in the file is
 * collected before the load throws, so `scripts/redemption/check.ts` — which
 * does nothing but import this module — reports them all in one run.
 */

/** Every approved value, keyed by item, in file order. */
export type ItemOptions = Readonly<Record<RedemptionItem, readonly string[]>>;

/**
 * The parsed file: every value of an item, and the values each role may be
 * given. A role's list is the untagged one followed by that role's subsection.
 */
export interface ParsedItemOptions {
  /** The union across roles, in file order. */
  readonly all: ItemOptions;
  readonly byRole: Readonly<Record<AttendeeRole, ItemOptions>>;
}

const ATTENDEE_ROLES: readonly AttendeeRole[] = ['participant', 'volunteer'];

const isAttendeeRole = (value: string): value is AttendeeRole =>
  (ATTENDEE_ROLES as readonly string[]).includes(value);

/** Raised for an options file that cannot be served. */
export class ItemOptionsError extends Error {
  /** One line per problem, each naming the file and, if any, its section. */
  readonly problems: readonly string[];

  /**
   * @param problems - What is wrong, one line each.
   */
  constructor(problems: readonly string[]) {
    super(problems.join('\n'));
    this.name = 'ItemOptionsError';
    this.problems = problems;
  }
}

/**
 * Longest value accepted. A meal choice or a shirt size, not prose.
 *
 * Enforced here rather than per request: the editor accepts only listed values
 * or the one already stored, so the file is the only place a new value enters.
 */
export const OPTION_MAX_LENGTH = 60;

const FILE = 'src/web/content/redemption-options.md';
const SOURCE = new URL(
  '../../web/content/redemption-options.md',
  import.meta.url,
);

const COMMENT_PATTERN = /^<!--[\s\S]*-->\s*$/;

/**
 * Names a block the grammar does not allow, for an error message.
 *
 * @param token - The offending block.
 */
const describe = (token: Token): string => {
  switch (token.type) {
    case 'heading':
      return `a level-${String((token as Tokens.Heading).depth)} heading`;
    case 'html':
      return 'raw HTML';
    case 'code':
      return 'a code block';
    case 'hr':
      return 'a horizontal rule';
    default:
      return `a ${token.type}`;
  }
};

/**
 * Whether a list item is a single line of plain text.
 *
 * Anything else — emphasis, a link, a task box, an escape — would be stored as
 * its Markdown source and shown to attendees that way.
 *
 * @param item - One bullet.
 */
const isPlainItem = (item: Tokens.ListItem): boolean => {
  const [only, ...rest] = item.tokens;

  return (
    !item.task &&
    rest.length === 0 &&
    only?.type === 'text' &&
    ((only as Tokens.Text).tokens ?? []).every(
      (token) => token.type === 'text',
    ) &&
    !item.text.includes('\n')
  );
};

/**
 * What one `##` section has gathered so far.
 *
 * `block` is where the next list belongs: `null` for the untagged one before
 * any `###`, a role for its subsection, or `skip` for a subsection whose list
 * is still read for its own problems but kept out of the result.
 */
interface SectionState {
  readonly item: RedemptionItem;
  readonly untagged: string[];
  /** Every accepted value, in the order the file gives them. */
  readonly union: string[];
  readonly byRole: Record<AttendeeRole, string[]>;
  /** Every value in the section, so a repeat is caught across blocks. */
  readonly seen: Set<string>;
  readonly roles: Set<AttendeeRole>;
  block: AttendeeRole | 'skip' | 'ignore' | null;
  subsection: string | null;
  hasList: boolean;
  hasAnyList: boolean;
  hasSubsection: boolean;
}

/**
 * Parses the options file.
 *
 * Pure: it reads nothing, so the loader and any future caller share one
 * grammar.
 *
 * @param source - The file's contents.
 * @param file - Repo-relative path, used only in error messages.
 * @returns The approved values for every item, in file order, as a whole and
 *   per role.
 * @throws {ItemOptionsError} Listing every departure from the grammar.
 */
export const parseItemOptions = (
  source: string,
  file: string,
): ParsedItemOptions => {
  const problems: string[] = [];
  const report = (
    problem: string,
    section?: string,
    subsection?: string | null,
  ): void => {
    if (section === undefined) {
      problems.push(`${file}: ${problem}`);
    } else if (subsection === undefined || subsection === null) {
      problems.push(`${file}: "## ${section}": ${problem}`);
    } else {
      problems.push(
        `${file}: "## ${section}" / "### ${subsection}": ${problem}`,
      );
    }
  };

  const sections = new Map<RedemptionItem, SectionState>();

  // The heading of the section the following blocks belong to, or `null` before
  // the first `##`. An unknown heading is kept so its blocks are skipped without
  // a second complaint.
  let section: string | null = null;
  let current: SectionState | undefined;
  let seenTitle = false;

  /** Closes the open subsection, if it never got its list. */
  const closeBlock = (): void => {
    if (
      current !== undefined &&
      current.subsection !== null &&
      current.block !== 'ignore' &&
      !current.hasList
    ) {
      report('has no list', current.item, current.subsection);
    }
  };

  const closeSection = (): void => {
    closeBlock();

    if (
      current !== undefined &&
      !current.hasAnyList &&
      !current.hasSubsection
    ) {
      report('has no options', current.item);
    }
  };

  for (const token of marked.lexer(source)) {
    // Comments carry the editing notes and are not part of the list.
    if (
      token.type === 'space' ||
      (token.type === 'html' && COMMENT_PATTERN.test(token.raw))
    ) {
      continue;
    }

    if (token.type === 'heading' && (token as Tokens.Heading).depth === 2) {
      closeSection();

      const name = (token as Tokens.Heading).text.trim();

      section = name;
      current = undefined;

      if (!isRedemptionItem(name)) {
        report(
          `"${name}" is not an item; sections are ${Object.keys(REDEEMABLE_ITEMS).join(', ')}`,
        );
      } else if (sections.has(name)) {
        report('is given twice', name);
      } else {
        current = {
          item: name,
          untagged: [],
          union: [],
          byRole: { participant: [], volunteer: [] },
          seen: new Set(),
          roles: new Set(),
          block: null,
          subsection: null,
          hasList: false,
          hasAnyList: false,
          hasSubsection: false,
        };
        sections.set(name, current);
      }

      continue;
    }

    if (section === null) {
      if (
        token.type === 'heading' &&
        (token as Tokens.Heading).depth === 1 &&
        !seenTitle
      ) {
        seenTitle = true;
      } else {
        report(`has ${describe(token)} before the first "##" section`);
      }

      continue;
    }

    if (current === undefined) continue;

    if (token.type === 'heading' && (token as Tokens.Heading).depth === 3) {
      closeBlock();

      const name = (token as Tokens.Heading).text.trim();

      current.subsection = name;
      current.hasList = false;
      current.hasSubsection = true;

      if (!isAttendeeRole(name)) {
        current.block = 'ignore';
        report(
          `"${name}" is not a role; subsections are ${ATTENDEE_ROLES.join(', ')}`,
          current.item,
          name,
        );
      } else if (current.roles.has(name)) {
        current.block = 'ignore';
        report('is given twice', current.item, name);
      } else {
        current.roles.add(name);

        if (name === 'participant' && isVolunteerOnlyItem(current.item)) {
          current.block = 'skip';
          report(
            'is for participants, who cannot hold this item',
            current.item,
            name,
          );
        } else {
          current.block = name;
        }
      }

      continue;
    }

    if (current.block === 'ignore') continue;

    const { item, subsection } = current;

    if (token.type !== 'list') {
      report(
        `has ${describe(token)} where only its list may go`,
        item,
        subsection,
      );
      continue;
    }

    if (current.hasList) {
      report('has more than one list', item, subsection);
      continue;
    }

    current.hasList = true;
    current.hasAnyList = true;

    const list = token as Tokens.List;

    if (list.ordered) {
      report('the list must be bulleted, not numbered', item, subsection);
    }

    const values =
      current.block === null
        ? current.untagged
        : current.block === 'skip'
          ? []
          : current.byRole[current.block];

    for (const entry of list.items) {
      const value = entry.text.normalize('NFC').trim();

      if (!isPlainItem(entry)) {
        report(
          `"${entry.text}" must be a single line of plain text`,
          item,
          subsection,
        );
      } else if (value === '') {
        report('has an empty option', item, subsection);
      } else if (value.length > OPTION_MAX_LENGTH) {
        report(
          `"${value}" is longer than ${String(OPTION_MAX_LENGTH)} characters`,
          item,
          subsection,
        );
      } else if (current.seen.has(value)) {
        report(`"${value}" is listed twice`, item, subsection);
      } else {
        current.seen.add(value);
        values.push(value);
        if (current.block !== 'skip') current.union.push(value);
      }
    }
  }

  closeSection();

  for (const item of Object.keys(REDEEMABLE_ITEMS) as RedemptionItem[]) {
    if (!sections.has(item)) report(`is missing its "## ${item}" section`);
  }

  if (problems.length > 0) throw new ItemOptionsError(problems);

  /** Freezes one list per item, drawn from the section's gathered values. */
  const collect = (
    pick: (state: SectionState) => readonly string[],
  ): ItemOptions => {
    const result = {} as Record<RedemptionItem, readonly string[]>;

    for (const item of Object.keys(REDEEMABLE_ITEMS) as RedemptionItem[]) {
      const state = sections.get(item);

      result[item] = Object.freeze(state === undefined ? [] : [...pick(state)]);
    }

    return Object.freeze(result);
  };

  // A volunteer-only item has no participant list, so the untagged one is the
  // volunteers' alone.
  const forRole = (role: AttendeeRole): ItemOptions =>
    collect((state) =>
      role === 'participant' && isVolunteerOnlyItem(state.item)
        ? []
        : [...state.untagged, ...state.byRole[role]],
    );

  return Object.freeze({
    all: collect((state) => state.union),
    byRole: Object.freeze({
      participant: forRole('participant'),
      volunteer: forRole('volunteer'),
    }),
  });
};

/**
 * Reads and parses the file.
 *
 * @throws {ItemOptionsError} If the file is missing or malformed.
 */
const load = (): ParsedItemOptions => {
  let source: string;

  try {
    source = readFileSync(SOURCE, 'utf8');
  } catch {
    throw new ItemOptionsError([`${FILE}: is missing`]);
  }

  return parseItemOptions(source, FILE);
};

const PARSED = load();

/** Every approved value of each item, whatever the role. Parsed at import. */
export const ITEM_OPTIONS: ItemOptions = PARSED.all;

/** The approved values of each item, per role. Parsed at import. */
export const ITEM_OPTIONS_BY_ROLE: ParsedItemOptions['byRole'] = PARSED.byRole;

/**
 * The approved options of an item for one role, in file order.
 *
 * @param item - The item the options are for.
 * @param role - The attendee's role.
 * @returns Empty for a participant and a volunteer-only item.
 */
export const optionsFor = (
  item: RedemptionItem,
  role: AttendeeRole,
): readonly string[] => PARSED.byRole[role][item];

/**
 * Whether a value is on the approved list for an item and role.
 *
 * Exact match: the value is stored as written, so a near-miss is a different
 * value.
 *
 * @param item - The item the value is for.
 * @param value - The trimmed value as received.
 * @param role - The role of the attendee who would hold it.
 */
export const isApprovedOption = (
  item: RedemptionItem,
  value: string,
  role: AttendeeRole,
): boolean => optionsFor(item, role).includes(value.normalize('NFC'));
