import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // The migration contract test starts a real embedded Postgres; the poller
    // fixture starts local http and https servers. Both bind ports, so files
    // run in separate processes to keep one file's servers away from another's.
    pool: "forks",
  },
});
