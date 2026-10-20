/**
 * What a shared item's select offers after the role changes.
 *
 * Pure so the rules can be tested without a DOM; `index.ts` only reads the
 * select, calls this and writes the result back.
 */

/** Everything the decision depends on. */
export interface RoleOptionsInput {
  /** The approved options for the role just chosen. */
  options: readonly string[];
  /** The value stored on the record, or empty when there is none. */
  stored: string;
  /** The role the page was rendered with. */
  renderedRole: string;
  /** The role just chosen. */
  newRole: string;
  /** What the select held before the change. Empty for "no entitlement". */
  previous: string;
  /** What the select held the last time it showed the new role, if ever. */
  remembered: string | undefined;
}

/** What to write back into the select, after its blank option. */
export interface RoleOptionsResult {
  options: readonly string[];
  /** The stored value to keep offering, labelled as off the list. */
  offList: string | null;
  /** The value to select; empty selects the blank option. */
  selected: string;
}

/**
 * Decides the options and the selection for a shared item under a new role.
 *
 * The stored value stays offered only while the role is the one the record was
 * saved with: the server accepts an off-list stored value only when the role is
 * unchanged, so offering it under another role would be a choice that is
 * refused on save.
 *
 * The selection is kept when the new list still has it; otherwise the choice
 * the operator last made under that role comes back, and otherwise the item is
 * cleared. A blank previous selection is never "kept", so switching away and
 * back restores a choice that the other role could not hold.
 *
 * @param input - The lists and selections to decide from.
 */
export const rebuildRoleOptions = ({
  options,
  stored,
  renderedRole,
  newRole,
  previous,
  remembered,
}: RoleOptionsInput): RoleOptionsResult => {
  const offList =
    stored !== '' && newRole === renderedRole && !options.includes(stored)
      ? stored
      : null;

  const offered = (value: string): boolean =>
    value !== '' && (options.includes(value) || value === offList);

  const selected = offered(previous)
    ? previous
    : remembered !== undefined && offered(remembered)
      ? remembered
      : '';

  return { options, offList, selected };
};
