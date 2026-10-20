/**
 * Which label an item select's blank option carries.
 *
 * Pure so the rule can be tested without a DOM; `index.ts` maps the key to the
 * copy in the page's inlined catalog.
 */

/** The catalog entry a blank option is labelled with. */
export type BlankItemLabel = 'none' | 'unavailable';

/**
 * Picks the label of a select's blank option.
 *
 * It is "unavailable" only while a volunteer-only item is blocked by the role;
 * otherwise "none", the operator's choice of no item. Returns a key rather than
 * text because the copy is read from the page's inlined catalog. `form.ejs`
 * applies the same rule when rendering.
 *
 * @param blocked - Whether the item is volunteer-only and the role is not volunteer.
 */
export const blankItemLabel = (blocked: boolean): BlankItemLabel =>
  blocked ? 'unavailable' : 'none';
