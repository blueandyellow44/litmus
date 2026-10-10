import pg from "pg";
import { env } from "../lib/env.js";
import { assertIsolatedDsn, assertNoDeployCredentials } from "../lib/isolation.js";

// Every worker reaches the database through this module, so the isolation
// guards sit here: an isolated run that somehow points at a remote database
// fails before the first connection rather than after the first write.
assertIsolatedDsn(env.DATABASE_URL);
assertNoDeployCredentials();

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

export async function withClient<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
