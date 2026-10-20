import type { RequestHandler } from 'express';

/**
 * Browser features denied for the document and everything it embeds. Only the
 * features listed here are restricted, so anything Turnstile's frame relies on
 * keeps its browser default.
 *
 * `camera=(self)` is for the QR scanner; `autoplay=(self)` because the scanner
 * plays a MediaStream.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=(self)',
  'camera=(self)',
  'display-capture=()',
  'encrypted-media=()',
  'geolocation=()',
  'gyroscope=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'usb=()',
].join(', ');

/**
 * Sets {@link PERMISSIONS_POLICY} on every response.
 *
 * Free of the environment so the standalone landing fallback sends the same
 * header as the live app.
 */
export const permissionsPolicy: RequestHandler = (_req, res, next) => {
  res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
  next();
};
