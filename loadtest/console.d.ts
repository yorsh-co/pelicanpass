/**
 * k6 provides `console`, but @types/k6 does not declare it and this project
 * leaves out the DOM lib that would.
 */
declare const console: {
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
  error(...data: unknown[]): void;
};
