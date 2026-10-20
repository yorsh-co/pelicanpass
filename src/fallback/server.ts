import 'dotenv/config';

import { createFallbackApp } from './app.ts';
import { readFallbackConfig } from './config.ts';

const config = readFallbackConfig();

const server = createFallbackApp(config).listen(config.port, () => {
  console.log(`Landing fallback listening on port ${String(config.port)}`);
});

// Docker stops with SIGTERM; closing lets in-flight responses finish.
const shutdown = (): void => {
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
