import { env } from '../../config/env.ts';
import { logger } from '../../shared/logger/logger.ts';
import { maskPhone } from '../../shared/utils/mask.ts';
import {
  TEMPLATE_RESOLVERS,
  type TemplateAttendeeRow,
  type WhatsappTemplate,
} from '../../constants/whatsapp-templates.ts';
import {
  classifySend,
  describeSendError,
  type SendClassification,
} from './whatsapp.errors.ts';

/** One parameter in a template component. */
interface TemplateParameter {
  type: 'text';
  text: string;
}

/** One component of the outgoing template message. */
interface TemplateComponent {
  type: 'body' | 'button';
  sub_type?: 'url';
  index?: string;
  parameters: TemplateParameter[];
}

/** The body of a `POST /{phone-number-id}/messages` request. */
export interface SendMessagePayload {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'template';
  template: {
    name: string;
    language: { code: string };
    components: TemplateComponent[];
  };
}

/** The parts of Meta's success envelope this client reads. */
interface SendSuccessEnvelope {
  contacts?: { input?: string; wa_id?: string }[];
  messages?: { id?: string; message_status?: string }[];
}

/** The parts of Meta's error envelope this client reads. */
interface SendErrorEnvelope {
  error?: {
    message?: string;
    code?: number;
    error_data?: { details?: string };
  };
}

/**
 * Outcome of one send attempt.
 *
 * `waId` and `messageStatus` are lifted out of the success envelope rather than
 * discarded because both carry information nothing else will tell us. `wa_id`
 * is the number Meta canonicalised to, which in Brazil can differ from what we
 * sent, and it is the key the delivery receipts arrive on. `message_status` is
 * `accepted`, `held_for_quality_assessment` or `paused` — the only
 * delivery-ish signal that arrives synchronously, and the last two mean the
 * send was taken but will not go out normally.
 */
export type SendOutcome =
  | { ok: true; wamid: string; waId: string; messageStatus: string }
  | {
      ok: false;
      classification: SendClassification;
      code: number | null;
      title: string;
      detail: string | null;
    };

/**
 * Builds the request body for one templated message.
 *
 * Separate from {@link sendTemplate} so that it can be printed and read by eye
 * against WhatsApp Manager without sending anything. Four things in here are
 * easy to get wrong and expensive to discover at message seven hundred, and all
 * four are visible in the output: the positional order of the body parameters,
 * the spelling of the language code, the button index as a string, and the fact
 * that the button parameter is a bare token rather than a URL.
 *
 * @param template - The registry entry being sent.
 * @param to - Recipient in E.164 without a `+`.
 * @param row - The attendee columns the resolvers may read.
 * @returns The JSON body, ready to post.
 */
export const buildTemplatePayload = (
  template: WhatsappTemplate,
  to: string,
  row: TemplateAttendeeRow,
): SendMessagePayload => {
  const components: TemplateComponent[] = [];

  if (template.body.length > 0) {
    components.push({
      type: 'body',
      parameters: template.body.map((variable) => ({
        type: 'text',
        text: TEMPLATE_RESOLVERS[variable](row),
      })),
    });
  }

  if (template.urlButton) {
    components.push({
      type: 'button',
      sub_type: 'url',
      index: template.urlButton.index,
      parameters: [
        {
          type: 'text',
          text: TEMPLATE_RESOLVERS[template.urlButton.variable](row),
        },
      ],
    });
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: template.name,
      language: { code: template.language },
      components,
    },
  };
};

/**
 * Reads Meta's answer, whatever shape it came back in.
 *
 * @param response - The HTTP response.
 * @returns What the run engine should do about it.
 */
const readResponse = async (response: Response): Promise<SendOutcome> => {
  // Meta's envelopes are asserted rather than parsed, the way the Turnstile
  // response is: only the handful of fields below are read, and a missing one
  // falls back rather than throwing.
  const body = (await response.json()) as SendSuccessEnvelope &
    SendErrorEnvelope;

  if (response.ok) {
    const message = body.messages?.[0];

    if (message?.id === undefined) {
      // A 2xx with no wamid is not something Meta documents, and it is not
      // safe to call a success: nothing could join a receipt to it later.
      return {
        ok: false,
        classification: 'transient',
        code: null,
        title: 'Resposta sem wamid',
        detail: null,
      };
    }

    return {
      ok: true,
      wamid: message.id,
      waId: body.contacts?.[0]?.wa_id ?? '',
      messageStatus: message.message_status ?? 'accepted',
    };
  }

  const code = body.error?.code ?? null;

  return {
    ok: false,
    classification: classifySend(code, response.status),
    code,
    title: body.error?.message ?? `HTTP ${String(response.status)}`,
    detail: body.error?.error_data?.details ?? null,
  };
};

/**
 * Sends one templated message.
 *
 * **Never throws.** A network failure, a timeout, a 4xx and a 5xx all come back
 * as an unsuccessful {@link SendOutcome}, the same contract `TurnstileValidator`
 * states — and it matters more here, because the caller is a paced
 * `setInterval` in which a rejection is unhandled rather than caught.
 *
 * **Nothing about the request is logged.** Not the number, which is masked, and
 * not the headers, which is the rule that keeps the access token out of the log
 * file: `Authorization: Bearer …` is carried on every one of these calls, and a
 * well-meant "log the request when it fails" is the single line that would
 * write it to disk.
 *
 * @param template - The registry entry being sent.
 * @param to - Recipient in E.164 without a `+`, from `toE164`.
 * @param row - The attendee columns the resolvers may read.
 * @returns The outcome. Never rejects.
 */
export const sendTemplate = async (
  template: WhatsappTemplate,
  to: string,
  row: TemplateAttendeeRow,
): Promise<SendOutcome> => {
  const url = `https://graph.facebook.com/${env.whatsapp.graphVersion}/${env.whatsapp.phoneNumberId}/messages`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.whatsapp.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTemplatePayload(template, to, row)),
      signal: AbortSignal.timeout(env.whatsapp.requestTimeout),
    });

    const outcome = await readResponse(response);

    if (outcome.ok) {
      logger.info(
        {
          to: maskPhone(to),
          wamid: outcome.wamid,
          status: outcome.messageStatus,
        },
        'whatsapp template sent',
      );
    } else {
      logger.warn(
        {
          to: maskPhone(to),
          code: outcome.code,
          classification: outcome.classification,
        },
        'whatsapp template refused',
      );
    }

    return outcome;
  } catch (error) {
    // A timeout arrives as a TimeoutError and a dropped connection as a
    // TypeError. Neither carries a Meta code, and both mean the same thing to
    // the run engine, so they are not told apart. The cause is logged so a
    // failure can still be diagnosed.
    const { title, cause } = describeSendError(error);

    logger.warn({ to: maskPhone(to), title, cause }, 'whatsapp send failed');

    return {
      ok: false,
      classification: classifySend(null, 0),
      code: null,
      title,
      detail: null,
    };
  }
};
