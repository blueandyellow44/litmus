// node ops/edition-clock/test.mjs
import assert from "node:assert/strict";
import worker, { pacificHour, startEdition } from "./src/index.js";

assert.equal(pacificHour(Date.UTC(2026, 9, 6, 10, 45)), 3); // PDT: the 10:45 UTC cron is 3 AM
assert.equal(pacificHour(Date.UTC(2026, 9, 6, 11, 45)), 4); // PDT: the 11:45 UTC cron is not
assert.equal(pacificHour(Date.UTC(2026, 11, 6, 11, 45)), 3); // PST: the 11:45 UTC cron is 3 AM
assert.equal(pacificHour(Date.UTC(2026, 11, 6, 10, 45)), 2); // PST: the 10:45 UTC cron is not

const env = { GITHUB_TOKEN: "t", GITHUB_REPO: "o/r", WORKFLOW_FILE: "daily.yml", EDITION_HOUR_PACIFIC: "3" };
let calls = [];
const ok = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 204 }); };
await startEdition(env, ok);
assert.equal(calls[0].url, "https://api.github.com/repos/o/r/actions/workflows/daily.yml/dispatches");
assert.deepEqual(JSON.parse(calls[0].init.body), { ref: "main", inputs: { run_story_ledger: "true" } });

await assert.rejects(startEdition(env, async () => new Response("Bad credentials", { status: 401 })), /401 Bad credentials/);
await assert.rejects(startEdition({ ...env, GITHUB_TOKEN: "" }, ok), /GITHUB_TOKEN is not set/);

// Exactly one of the day's two crons dispatches, in summer and in winter.
for (const [month, label] of [[9, "PDT"], [11, "PST"]]) {
  let fired = 0;
  const real = globalThis.fetch;
  globalThis.fetch = async () => { fired++; return new Response(null, { status: 204 }); };
  for (const h of [10, 11]) await worker.scheduled({ scheduledTime: Date.UTC(2026, month, 6, h, 45) }, env);
  globalThis.fetch = real;
  assert.equal(fired, 1, `${label}: one dispatch a day`);
}
console.log("edition clock: all checks pass");
