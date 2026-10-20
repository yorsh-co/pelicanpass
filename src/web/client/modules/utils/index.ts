import timing from './async/timing.ts';
import { sleep } from './async/sleep.ts';
import { isDesktop } from './browser/viewport.ts';
import { formatPhone } from './formatters/phone.ts';

/** Single import surface for the browser utility modules. */
const utils = {
  sleep,
  timing,
  isDesktop,
  formatPhone,
};

export default utils;
