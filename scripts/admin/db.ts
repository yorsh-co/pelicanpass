import 'dotenv/config';

import pkg from 'pg';

const { Pool } = pkg;

/**
 * A pool connected as the **migrator** role, for the admin CLI.
 *
 * Not `src/shared/db/postgres.ts`, which connects as the application role.
 * Migration 013 deliberately withholds `INSERT` and `DELETE` on `admins` from
 * that role, so that nothing reachable from an HTTP request can mint or remove
 * an administrator. Provisioning therefore has to connect as the role that owns
 * the schema — the same one `npm run migrate` uses.
 *
 * @throws {Error} If the migrator credentials are not in the environment.
 */
const required = (key: string): string => {
  const value = process.env[key];

  if (!value) throw new Error(`Missing environment variable: ${key}`);

  return value;
};

export const db = new Pool({
  host: required('POSTGRES_HOST'),
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  database: required('POSTGRES_DB'),
  user: required('POSTGRES_MIGRATOR_USER'),
  password: required('POSTGRES_MIGRATOR_PASSWORD'),
  max: 1,
  connectionTimeoutMillis: 5_000,
});
