import { stdin, stdout } from 'node:process';

/**
 * Reads a password from the terminal without echoing it.
 *
 * `readline` has no muted mode, so the prompt is written by hand and the
 * terminal is put in raw mode for the duration: characters are read one at a
 * time, nothing is written back, and the mode is restored in a `finally` so an
 * interrupted run does not leave the shell unable to echo.
 *
 * A password must never be passed as an argv flag — it would land in shell
 * history and in the process list — which is why this exists at all.
 *
 * @param label - Prompt to show.
 * @returns The password as typed.
 * @throws {Error} If the input is not a TTY, or the user interrupts.
 */
export const readPassword = async (label: string): Promise<string> => {
  if (!stdin.isTTY) {
    throw new Error(
      'A password must be typed at a terminal. Run this with `docker compose exec`, not through a pipe.',
    );
  }

  stdout.write(label);

  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';

      const onData = (chunk: string): void => {
        for (const char of chunk) {
          switch (char) {
            // Enter, on either line ending.
            case '\r':
            case '\n': {
              stdin.off('data', onData);
              stdout.write('\n');

              resolve(value);
              return;
            }

            // Ctrl-C.
            case '\u0003': {
              stdin.off('data', onData);
              stdout.write('\n');

              reject(new Error('Cancelled'));
              return;
            }

            // Backspace and delete. Nothing was echoed, so nothing is erased on
            // screen — only the buffer shortens.
            case '\u0008':
            case '\u007f': {
              value = value.slice(0, -1);
              break;
            }

            default: {
              value += char;
            }
          }
        }
      };

      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
};
