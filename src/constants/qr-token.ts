/**
 * Shape of `CHECKIN_QR_TOKEN`, the token printed on the venue posters.
 *
 * Shared by the server validator and `scripts/qr/urls.ts`, so the URLs the
 * script prints are held to the same rule the door applies.
 */
export const QR_TOKEN_PATTERN = /^[a-zA-Z0-9]{10,32}$/;
