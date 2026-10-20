/** The part of the logger the notices need. */
interface WarnLogger {
  warn: (message: string) => unknown;
}

/** The part of the validated config the notices read. */
interface NoticeConfig {
  nodeEnv: string;
  captchaAdmin: { enforce: boolean };
}

/**
 * Logs boot-time notices about configuration that is valid but weakens a
 * control. Lives apart from `env.ts` because the logger depends on it.
 *
 * @param log - Logger to write the notices to.
 * @param config - The validated environment.
 */
export const logStartupNotices = (
  log: WarnLogger,
  config: NoticeConfig,
): void => {
  if (config.nodeEnv === 'production' && !config.captchaAdmin.enforce) {
    log.warn(
      'TURNSTILE_ADMIN_ENFORCE is false: admin sign-in does not require a captcha, so anyone holding an Access assertion can lock a named administrator out. Intended only as the Turnstile outage rescue; set it back to true once Turnstile recovers.',
    );
  }
};
