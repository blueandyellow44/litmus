// Unit tests must run without a database.
//
// env.ts validates DATABASE_URL at module load, and lib/logger.ts imports it, so
// importing any module that logs — the RSS poller, for instance, which touches
// no database at all — fails without one. That coupling is worth fixing
// properly one day; until then this supplies a placeholder that is never
// connected to.
//
// The value is deliberately a loopback address on a port nothing listens on. If
// a test ever does open a connection by accident it fails immediately rather
// than reaching something real, and the isolation guard would refuse it anyway.
process.env.DATABASE_URL ??= "postgres://litmus:litmus@127.0.0.1:1/litmus_test_placeholder";
