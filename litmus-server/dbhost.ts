// Hosts a local embedded Postgres for LITMUS dev. No seeding — real ingest only.
import EmbeddedPostgres from "embedded-postgres";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
const DATA_DIR = "/private/tmp/claude-501/-Users-maxsheahan-LITMUS2/e68e8be2-68b9-41e9-8faa-608616c60cf7/scratchpad/pgdata3";
const pg = new EmbeddedPostgres({ databaseDir: DATA_DIR, user: "litmus", password: "litmus", port: 5432, persistent: true });
const fresh = !existsSync(DATA_DIR + "/PG_VERSION");
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("litmus");
const { pool } = await import("./src/db/client.js");
await pool.query(await readFile("./src/db/schema.sql", "utf-8"));
await pool.end();
console.log("DB READY on :5432 (schema applied, no seed)");
process.on("SIGINT", async () => { await pg.stop(); process.exit(0); });
process.on("SIGTERM", async () => { await pg.stop(); process.exit(0); });
await new Promise(() => {});
