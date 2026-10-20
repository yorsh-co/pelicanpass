/**
 * Fails when src/web/content/redemption-options.md cannot be served.
 *
 * Runs exactly the checks the application runs at boot, by loading the module
 * that runs them, so a malformed file fails `npm run check` rather than the
 * deploy. It reports every problem in the file, not just the first:
 *
 * - the file is missing;
 * - an item's `##` section is missing, repeated or unknown;
 * - a section holds anything but a bulleted list, or role subsections
 *   (`### participant`, `### volunteer`) each with one, and a subsection is
 *   unknown, repeated, empty, or for a participant under a volunteer-only item;
 * - an option is empty, overlong, formatted, or listed twice within its section.
 *
 * Usage:
 *   node scripts/redemption/check.ts
 */

import type { ItemOptionsError } from '../../src/modules/admin/admin.item-options.ts';

try {
  const { ITEM_OPTIONS } =
    await import('../../src/modules/admin/admin.item-options.ts');

  const counts = Object.entries(ITEM_OPTIONS)
    .map(([item, values]) => `${item}: ${String(values.length)}`)
    .join(', ');

  console.log(`✓ redemption options check passed (${counts})`);
} catch (error) {
  // Matched by name: a module that throws while loading exports nothing, the
  // error class included.
  if (!(error instanceof Error) || error.name !== 'ItemOptionsError') {
    throw error;
  }

  for (const problem of (error as ItemOptionsError).problems) {
    console.error(`redemption-options: ${problem}`);
  }

  console.error('redemption-options: see docs/features/redemption-options.md');
  process.exit(1);
}
