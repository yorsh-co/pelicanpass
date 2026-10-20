import type { Locale } from '../../i18n/locales.ts';

/**
 * The web app manifest served at `/site.webmanifest`, and written out by the
 * static closing-site build.
 *
 * Pure so both can share it: the name stays tied to `APP_TITLE`, which every
 * page title already reads.
 *
 * @param appTitle - Installed app's name.
 * @param locale - Language of the manifest.
 */
export const siteManifest = (appTitle: string, locale: Locale) => ({
  name: appTitle,
  short_name: appTitle,
  lang: locale,
  start_url: '/',
  display: 'standalone',
  // The layouts carry a prefers-color-scheme pair; a manifest takes one
  // value, so this is the light literal they default to.
  background_color: '#fafafc',
  theme_color: '#fafafc',
  icons: [
    {
      src: '/assets/images/icon/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/assets/images/icon/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any',
    },
    {
      src: '/assets/images/icon/icon-512-maskable.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'maskable',
    },
  ],
});
