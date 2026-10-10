// Migration CLI. Use: npm run migrate:status | migrate:up | migrate:down
import { status, up, down } from "../db/migrate.js";
import { shutdown, crashAndShutdown } from "../lib/shutdown.js";

const command = process.argv[2] ?? "status";

// Lets a harness point the runner at a fixture directory. Production never sets
// it, so the default stays litmus-server/migrations.
const dir = process.env.LITMUS_MIGRATIONS_DIR || undefined;

async function main(): Promise<void> {
  switch (command) {
    case "status":
      await status(dir);
      break;
    case "up":
      await up(dir);
      break;
    case "down":
      await down(dir);
      break;
    default:
      throw new Error(`unknown migrate command "${command}" (expected status | up | down)`);
  }
  await shutdown();
}

main().catch((err) => crashAndShutdown(`migrate ${command}`, err));
