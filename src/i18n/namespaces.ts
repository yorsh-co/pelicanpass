/**
 * Message namespaces, one per surface. A page loads only its own, which keeps
 * inlined catalogs small and maps one-to-one onto the copy review document.
 *
 * `translatable: false` keeps a namespace out of TMS exports and out of the
 * pseudo-locale: its text is served in pt-BR in every locale. Every namespace is
 * translatable today; the flag stays for a surface that must not be.
 */
const DEFINITIONS = [
  { name: 'chrome', translatable: true },
  { name: 'landing', translatable: true },
  { name: 'errors', translatable: true },
  { name: 'checkin', translatable: true },
  { name: 'pass', translatable: true },
  { name: 'staff', translatable: true },
  { name: 'raffle', translatable: true },
  { name: 'qr', translatable: true },
  { name: 'survey', translatable: true },
  { name: 'admin-shell', translatable: true },
  { name: 'admin-attendees', translatable: true },
  { name: 'admin-lookup', translatable: true },
  { name: 'admin-whatsapp', translatable: true },
  { name: 'admin-login', translatable: true },
  { name: 'admin-errors', translatable: true },
  { name: 'admin-metrics', translatable: true },
  { name: 'admin-survey', translatable: true },
  { name: 'admin-redemptions', translatable: true },
  { name: 'admin-tshirts', translatable: true },
  { name: 'admin-pass', translatable: true },
  { name: 'admin-volunteers', translatable: true },
] as const;

export type Namespace = (typeof DEFINITIONS)[number]['name'];

/**
 * The namespaces, with `translatable` widened to `boolean` so that code
 * branching on it stays meaningful whichever way each one is set.
 */
export const NAMESPACES: readonly {
  readonly name: Namespace;
  readonly translatable: boolean;
}[] = DEFINITIONS;
