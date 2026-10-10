#!/usr/bin/env node
// Proves two things about scripts/refresh.sh (security baseline, 2026-10-07):
//
//   1. It deploys with the wrangler pinned in litmus-client's lockfile, and
//      refuses to start, before anything is ingested, when that is missing.
//      It never falls back to `npx wrangler`, which fetched whatever version the
//      registry served that morning.
//   2. The Pages token reaches the deploy command and not the workers, when
//      JEV_API_TOKEN is set. When it is not, Jev's fallback to the Pages token
//      (lib/env.ts) is preserved, so scoring does not quietly leave Jev.
//
// It runs the REAL refresh.sh, copied into a throwaway root whose npm, npx,
// node, curl and wrangler are fakes that record the environment they were
// given. No network, no database, no credentials: the token is a dummy string.
//
// Usage: node scripts/refresh-deploy-scope-test.mjs

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DUMMY_TOKEN = "dummy-pages-token-for-refresh-test";

// A fake executable that appends "<name> token=<present|absent> args=..." to the log.
function fake(file, name, body = "") {
  writeFileSync(
    file,
    `#!/usr/bin/env bash
printf '%s token=%s args=%s\\n' "${name}" "$([ -n "\${CLOUDFLARE_API_TOKEN:-}" ] && echo present || echo absent)" "$*" >> "$CALL_LOG"
${body}
exit 0
`,
  );
  chmodSync(file, 0o755);
}

function scenario({ jev, withWrangler, skipDeploy }) {
  const root = mkdtempSync(path.join(tmpdir(), "litmus-refresh-scope-"));
  try {
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "litmus-server"));
    mkdirSync(path.join(root, "litmus-client", "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(root, "bin"));
    copyFileSync(path.join(REPO, "scripts", "refresh.sh"), path.join(root, "scripts", "refresh.sh"));
    writeFileSync(path.join(root, "scripts", "build-snapshot.mjs"), "");

    const bin = path.join(root, "bin");
    // `npm run score` must report a drained queue so the scoring loop ends.
    fake(path.join(bin, "npm"), "npm", `case "$*" in *score*) echo '{"msg":"no unscored articles"}';; esac`);
    fake(path.join(bin, "npx"), "npx");
    fake(path.join(bin, "node"), "node");
    fake(path.join(bin, "curl"), "curl");
    if (withWrangler) fake(path.join(root, "litmus-client", "node_modules", ".bin", "wrangler"), "wrangler");

    const log = path.join(root, "calls.log");
    const env = {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: root,
      CALL_LOG: log,
      DATABASE_URL: "postgres://unused@127.0.0.1:1/unused",
      ANTHROPIC_API_KEY: "dummy",
      CLOUDFLARE_API_TOKEN: DUMMY_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: "dummy-account",
      PORT: "18787",
    };
    if (jev) env.JEV_API_TOKEN = "dummy-jev-token";
    if (skipDeploy) env.SKIP_DEPLOY = "1";

    const run = spawnSync("bash", [path.join(root, "scripts", "refresh.sh")], { env, encoding: "utf8", timeout: 30_000 });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
    return { status: run.status, output: run.stdout + run.stderr, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    failed += 1;
    console.log(detail);
  }
}
const workers = (calls) => calls.filter((c) => c.startsWith("npm "));
const deploys = (calls) => calls.filter((c) => c.startsWith("wrangler "));

{
  const r = scenario({ jev: true, withWrangler: true });
  check("completes with the fakes", r.status === 0, r.output);
  check("deploys through the pinned wrangler", deploys(r.calls).length === 1 && deploys(r.calls)[0].includes("pages deploy dist"), r.calls);
  check("never calls npx", !r.calls.some((c) => c.startsWith("npx ")), r.calls);
  check("the deploy command holds the Pages token", deploys(r.calls).every((c) => c.includes("token=present")), r.calls);
  check(
    "no worker holds the Pages token when Jev has its own",
    workers(r.calls).length > 0 && workers(r.calls).every((c) => c.includes("token=absent")),
    r.calls,
  );
}
{
  const r = scenario({ jev: false, withWrangler: true });
  check("without JEV_API_TOKEN the workers keep the token Jev falls back to", workers(r.calls).every((c) => c.includes("token=present")), r.calls);
  check("and the run says so", /JEV_API_TOKEN is unset/.test(r.output), r.output);
}
{
  const r = scenario({ jev: true, withWrangler: false });
  check("refuses when the pinned wrangler is missing", r.status !== 0 && /pinned wrangler is not installed/.test(r.output), r.output);
  check("and refuses before any work is done", r.calls.length === 0, r.calls);
}
{
  const r = scenario({ jev: true, withWrangler: false, skipDeploy: true });
  check("SKIP_DEPLOY=1 does not need wrangler", r.status === 0 && deploys(r.calls).length === 0, r.output);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nrefresh.sh deploys with the pinned wrangler and keeps the Pages token to the deploy step.");
