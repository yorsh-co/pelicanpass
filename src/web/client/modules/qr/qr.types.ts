/**
 * Types the QR scanner needs from whoever drives it.
 */

/** Per-error-code messages, keyed by the backend's `AppErrorCode`. */
export type ErrorCopy = Record<string, string>;

/**
 * Where a flow transition should apply its `processing` class.
 */
export interface FlowOptions {
  /** Element to mark, when it is not the step's own container. */
  target?: Element;

  /** Leave the current hint in place rather than clearing it. */
  keepHint?: boolean;
}

/** Every string the scanner can display, for one surface. */
export interface QrCopy {
  header: string;
  cameraButton: string;
  torchButton: string;
  switchCameraButton: string;
  closeButton: string;
  defaultHint: string;
  cameraAccessRequest: string;
  help: string;
  processing: string;
  success: string;
  error: ErrorCopy;
  unknownError: string;
  cameraAccessError: string;
}
