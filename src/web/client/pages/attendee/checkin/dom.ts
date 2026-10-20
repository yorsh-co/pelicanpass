import { qs } from '../../../layouts/main/dom.ts';

const dom = Object.freeze({
  main: {
    container: qs('[data-checkin="main-container"]'),
  },

  steps: {
    qr: qs('[data-checkin="qr-step"]'),
    ticket: qs('[data-checkin="ticket-step"]'),
    verification: qs('[data-checkin="verification-step"]'),
    success: qs('[data-checkin="success-step"]'),
  },

  inputs: {
    ticketCode: qs<HTMLInputElement>('[data-checkin="ticket-code-input"]'),
    verificationCode: qs<HTMLInputElement>(
      '[data-checkin="verification-code-input"]',
    ),
  },

  ticket: {
    hint: qs('[data-checkin="ticket-hint-div"]'),
    inputWrapper: qs('[data-checkin="ticket-input-wrapper"]'),
    captcha: qs('[data-checkin="ticket-captcha-div"]'),
  },

  verification: {
    hint: qs('[data-checkin="verification-hint-div"]'),
    tableWrapper: qs('[data-checkin="verification-table-wrapper"]'),
    tableToggle: qs<HTMLButtonElement>(
      '[data-checkin="verification-table-toggle"]',
    ),
    tableToggleLabel: qs('[data-checkin="verification-table-toggle-label"]'),
    inputWrapper: qs('[data-checkin="verification-input-wrapper"]'),
    backBtn: qs<HTMLButtonElement>('[data-checkin="verification-back-btn"]'),
  },

  qr: {
    hint: qs('[data-checkin="qr-hint-div"]'),
    tableWrapper: qs('[data-checkin="qr-table-wrapper"]'),
    tableToggle: qs<HTMLButtonElement>('[data-checkin="qr-table-toggle"]'),
    tableToggleLabel: qs('[data-checkin="qr-table-toggle-label"]'),
    wrapper: qs('[data-checkin="qr-reader-wrapper"]'),
    reader: qs('[data-checkin="qr-reader-div"]'),
    startBtn: qs<HTMLButtonElement>('[data-checkin="start-camera-btn"]'),
    torchBtn: qs<HTMLButtonElement>('[data-checkin="qr-torch-btn"]'),
    switchBtn: qs<HTMLButtonElement>('[data-checkin="qr-switch-btn"]'),
    closeBtn: qs<HTMLButtonElement>('[data-checkin="qr-close-btn"]'),
    presenceBtn: qs<HTMLButtonElement>('[data-checkin="qr-presence-btn"]'),
  },

  success: {
    hint: qs('[data-checkin="success-hint-div"]'),
    message: qs('[data-checkin="success-message"]'),
    greeting: qs('[data-checkin="success-greeting"]'),
    numberBlock: qs('[data-checkin="success-number-block"]'),
    checkinNumber: qs('[data-checkin="success-checkinNumber"]'),
  },
});

export default dom;
