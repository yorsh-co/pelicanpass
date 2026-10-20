import { setupQr } from '../../../../modules/qr/qr.ts';
import utils from '../../../../modules/utils/index.ts';
import ui from '../../../../modules/ui/index.ts';
import { attachSegmentedInput } from '../../../../components/input/segmented.ts';
import { TurnstileCaptcha } from '../../../../components/captcha/captcha.ts';
import api from '../../../../core/api/index.ts';

import dom from '../dom.ts';

import { goToStep } from '../ui/navigation.ts';
import { runSuccessFlow } from '../steps/success.step.ts';
import { onPresenceCheck, onQrScan } from '../steps/qr.step.ts';
import { populateStepCopy, populateStepValues } from '../ui/values.ts';
import { onVerificationInput } from '../steps/verification.step.ts';
import { onTicketInput } from '../steps/ticket.step.ts';
import {
  formatVerificationCode,
  isValidVerificationCode,
} from '../ui/formatters.ts';
import {
  displayTicketCode,
  formatTicket,
  isValidTicketCode,
  TICKET_CODE_LENGTH,
} from '../../../../../../constants/ticket.ts';
import { setupTableToggle } from '../ui/table-toggle.ts';
import { setupInput } from '../ui/inputs.ts';
import { createStepFlow } from '../ui/flow.ts';
import { getAudienceCopy } from '../ui/messages.ts';
import { logger } from '../../../../modules/log/logger.ts';

import type { StepConfigMap } from '../types.ts';

/** Digits of the phone number the verification step asks for. */
const VERIFICATION_CODE_LENGTH = 4;

const stepConfig: StepConfigMap = {
  ticket: {
    next: ['verification'],

    step: dom.steps.ticket,
    hint: dom.ticket.hint,
    input: dom.inputs.ticketCode,
    focusTarget: dom.inputs.ticketCode,

    getCopy: () => getAudienceCopy().ticket,

    captcha: new TurnstileCaptcha(dom.ticket.captcha, {
      action: 'ticket-code-input',
    }),

    getFlow() {
      this._flow ??= createStepFlow({
        step: this.step,
        hint: this.hint,
        input: this.input,
        focusTarget: this.focusTarget,
      });

      return this._flow;
    },

    onEnter(state, { skeleton }) {
      const copy = this.getCopy();

      if (skeleton) {
        ui.skeleton.render(this.step);
        return;
      }

      const { captchaRequired } = state;

      if (captchaRequired) {
        this.captcha.render();
      }

      ui.skeleton.clear(this.step);

      populateStepCopy('ticket', { header: copy.header });

      setupInput(this.input, {
        onInput: onTicketInput,
        formatValue: formatTicket,
        valueIsValid: isValidTicketCode,
      });

      attachSegmentedInput(this.input, () => TICKET_CODE_LENGTH);

      const flow = this.getFlow();
      void flow.idle(copy.defaultHint);
    },

    onExit() {
      if (this.captcha.widgetId) {
        this.captcha.remove();
      }

      const flow = this.getFlow();
      void flow.hidden();

      ui.skeleton.render(this.step);
    },
  },

  verification: {
    next: ['ticket', 'qr', 'success'],

    step: dom.steps.verification,
    input: dom.inputs.verificationCode,
    hint: dom.verification.hint,
    btn: dom.verification.backBtn,
    focusTarget: dom.inputs.verificationCode,

    getCopy: () => getAudienceCopy().verification,

    getFlow() {
      this._flow ??= createStepFlow({
        step: this.step,
        hint: this.hint,
        input: this.input,
        btn: this.btn,
        focusTarget: this.focusTarget,
      });

      return this._flow;
    },

    onEnter(state, { skeleton }) {
      const copy = this.getCopy();

      populateStepCopy('verification', {
        ...copy,
        ...getAudienceCopy().userPreview,
      });

      if (skeleton) {
        ui.skeleton.render(this.step);
        return;
      }

      const { session } = state;

      if (!session?.attendeePreview) {
        throw new Error('Attendee preview data is missing');
      }

      ui.skeleton.clear(this.step);

      populateStepValues('verification', session.attendeePreview, {
        formatters: {
          phoneStart: (value) => utils.formatPhone.locale(value, 'pt-BR'),
          ticketCode: displayTicketCode,
        },
      });

      setupTableToggle({
        toggle: dom.verification.tableToggle,
        wrapper: dom.verification.tableWrapper,
        label: dom.verification.tableToggleLabel,
      });

      setupInput(this.input, {
        onInput: onVerificationInput,
        formatValue: formatVerificationCode,
        valueIsValid: isValidVerificationCode,
      });

      attachSegmentedInput(this.input, () => VERIFICATION_CODE_LENGTH);

      this.btn.onclick = () => {
        void api.checkin.reset();

        void goToStep('ticket');
      };

      const flow = this.getFlow();
      void flow.idle(copy.defaultHint);
    },

    onExit() {
      dom.verification.tableToggle.disabled = true;

      const flow = this.getFlow();
      void flow.hidden();

      ui.skeleton.render(this.step);
    },
  },

  qr: {
    next: ['ticket', 'verification', 'success'],

    step: dom.steps.qr,
    hint: dom.qr.hint,
    btn: dom.qr.startBtn,

    getCopy: () => getAudienceCopy().qr,

    getFlow() {
      this._flow ??= createStepFlow({
        step: this.step,
        hint: this.hint,
        btn: this.btn,
      });

      return this._flow;
    },

    onEnter(state, { skeleton }) {
      const copy = this.getCopy();

      populateStepCopy('qr', {
        ...copy,
        ...getAudienceCopy().userPreview,
      });

      if (skeleton) {
        ui.skeleton.render(this.step);
        return;
      }

      const { session } = state;

      const attendeePreview = session?.attendeePreview;

      if (!attendeePreview) {
        logger.warn('step', 'attendee preview data is missing'); // TODO: throw error?
      }

      ui.skeleton.clear(this.step);

      populateStepValues('qr', attendeePreview, {
        formatters: {
          phoneStart: (value) => utils.formatPhone.locale(value, 'pt-BR'),
          ticketCode: displayTicketCode,
        },
      });

      setupTableToggle({
        toggle: dom.qr.tableToggle,
        wrapper: dom.qr.tableWrapper,
        label: dom.qr.tableToggleLabel,
      });

      const flow = this.getFlow();

      setupQr({
        // TODO: review
        qrReaderDiv: dom.qr.reader,
        startCameraBtn: dom.qr.startBtn,
        torchBtn: dom.qr.torchBtn,
        switchBtn: dom.qr.switchBtn,
        closeBtn: dom.qr.closeBtn,
        hintDiv: dom.qr.hint,
        onScan: onQrScan,

        onProcessingStart: (msg) =>
          flow.processing(msg, { target: dom.qr.wrapper }),
        onProcessingEnd: (msg, options) =>
          flow.idle(msg, { target: dom.qr.wrapper, ...options }),
        onError: (msg) => flow.error(msg),

        copy,
      });

      // Assigned rather than added, so a return to this step replaces the
      // handler instead of stacking another. Re-enabled here because the last
      // visit may have left it disabled by a check that moved the flow on.
      dom.qr.presenceBtn.classList.remove('loading');
      dom.qr.presenceBtn.disabled = false;
      dom.qr.presenceBtn.onclick = () => void onPresenceCheck();

      void flow.idle(copy.defaultHint);
    },

    onExit() {
      dom.qr.tableToggle.disabled = true;
      dom.qr.presenceBtn.disabled = true;

      const flow = this.getFlow();
      void flow.hidden();

      ui.skeleton.render(this.step);
    },
  },

  success: {
    step: dom.steps.success,

    getCopy: () => getAudienceCopy().success,

    async onEnter() {
      populateStepCopy('success', this.getCopy());

      await runSuccessFlow();
    },
  },
};

export default stepConfig;
