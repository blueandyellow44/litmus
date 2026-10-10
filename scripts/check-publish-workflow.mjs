#!/usr/bin/env node
// Guards the shape of the publishing workflow (security baseline, 2026-10-07):
//
//   1. No secret sits at job level in daily.yml's refresh job, where every step,
//      including `npm ci` and its dependencies' install scripts, would hold it.
//   2. No step that installs dependencies is given a secret.
//   3. The pre-publication checks exist, hold no secrets, can fail the run
//      (no continue-on-error), and come before migrations and the funnel, so a
//      failing check leaves production and the live edition untouched.
//   4. pr.yml, which runs untrusted branch code, references no secret at all.
//
// A text check, not a YAML parse: the repository carries no YAML parser, and
// these rules are about where a line sits inside the refresh job, which the
// fixed indentation of these files makes plain.
//
//   node scripts/check-publish-workflow.mjs                  # the check
//   node scripts/check-publish-workflow.mjs --prove-it-fails  # plant each violation, require it caught

import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DAILY = readFileSync(path.join(ROOT, ".github/workflows/daily.yml"), "utf8");
const PR = readFileSync(path.join(ROOT, ".github/workflows/pr.yml"), "utf8");

const CHECK_PREFIX = "Pre-publication checks";

// The refresh job's text, split into its job-level env block and its steps.
function refreshJob(daily) {
  const lines = daily.split("\n");
  const start = lines.findIndex((l) => l === "  refresh:");
  if (start < 0) throw new Error("daily.yml has no refresh job");
  let end = lines.findIndex((l, i) => i > start && /^  \S/.test(l));
  if (end < 0) end = lines.length;
  const job = lines.slice(start + 1, end);

  const envAt = job.findIndex((l) => l === "    env:");
  const envBlock = [];
  if (envAt >= 0) {
    for (const l of job.slice(envAt + 1)) {
      if (/^    \S/.test(l)) break;
      envBlock.push(l);
    }
  }

  const stepsAt = job.findIndex((l) => l === "    steps:");
  if (stepsAt < 0) throw new Error("refresh job has no steps");
  const steps = [];
  for (const l of job.slice(stepsAt + 1)) {
    if (/^      - /.test(l)) steps.push([l]);
    else if (steps.length > 0) steps[steps.length - 1].push(l);
  }
  return {
    env: envBlock.filter((l) => !/^\s*#/.test(l)).join("\n"),
    steps: steps.map((s) => {
      const text = s.filter((l) => !/^\s*#/.test(l)).join("\n");
      const name = (text.match(/- name:\s*"?([^"\n]+)"?/) ?? [])[1] ?? (text.match(/- uses:\s*(\S+)/) ?? [])[1] ?? "";
      return { name, text };
    }),
  };
}

function violations(daily, pr) {
  const found = [];
  const job = refreshJob(daily);

  if (/secrets\./.test(job.env)) found.push("a secret is set at the refresh job's level");

  for (const s of job.steps) {
    if (/npm ci/.test(s.text) && /secrets\./.test(s.text)) found.push(`install step "${s.name}" is given a secret`);
  }

  const checks = job.steps.map((s, i) => ({ ...s, i })).filter((s) => s.name.startsWith(CHECK_PREFIX));
  if (checks.length < 3) found.push(`expected the server, client and guard ${CHECK_PREFIX} steps, found ${checks.length}`);
  const at = (prefix) => job.steps.findIndex((s) => s.name.startsWith(prefix));
  const migrate = at("Apply pending migrations");
  const funnel = at("Run the funnel");
  if (funnel < 0) found.push("no funnel step");
  for (const c of checks) {
    if (/secrets\./.test(c.text)) found.push(`check "${c.name}" is given a secret`);
    if (/continue-on-error:\s*true/.test(c.text)) found.push(`check "${c.name}" cannot fail the run`);
    if (/\bif:/.test(c.text)) found.push(`check "${c.name}" is conditional`);
    if ((migrate >= 0 && c.i > migrate) || (funnel >= 0 && c.i > funnel)) found.push(`check "${c.name}" runs after migrations or the funnel`);
  }
  for (const needed of ["npm test", "npm run typecheck", "refresh-deploy-scope-test.mjs", "isolation-guards-test.mjs", "receipt-publish-gate-test.mjs"]) {
    if (!checks.some((c) => c.text.includes(needed))) found.push(`no ${CHECK_PREFIX} step runs ${needed}`);
  }

  if (/secrets\./.test(pr.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"))) found.push("pr.yml references a secret");
  return found;
}

if (process.argv.includes("--prove-it-fails")) {
  const firstCheck = /( {6}- name: "Pre-publication checks: server types and tests"\n)/;
  const plants = [
    // ^ with m matches the job's own 4-space env, not a step's 8-space one.
    ["a secret at job level", (d) => d.replace(/^    env:\n/m, "    env:\n      DATABASE_URL: ${{ secrets.DATABASE_URL }}\n")],
    ["a secret on npm ci", (d) => d.replace("        run: npm ci\n", "        env:\n          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}\n        run: npm ci\n")],
    ["a check that cannot fail", (d) => d.replace(firstCheck, "$1        continue-on-error: true\n")],
    ["a check given a secret", (d) => d.replace(firstCheck, "$1        env:\n          DATABASE_URL: ${{ secrets.DATABASE_URL }}\n")],
    ["the checks removed", (d) => d.replaceAll(CHECK_PREFIX, "Optional checks")],
    ["tests dropped from the checks", (d) => d.replaceAll("npm test", "echo skipped")],
    ["a check moved after the funnel", (d) => d.replace(/( {6}- name: "Pre-publication checks: client tests"\n(?: {8}.*\n)+)/, "") + '      - name: "Pre-publication checks: client tests"\n        run: npm test\n'],
  ];
  let missed = 0;
  for (const [label, plant] of plants) {
    const planted = plant(DAILY);
    if (planted === DAILY) {
      console.log(`MISSED  ${label}: the plant did not apply, so it proves nothing`);
      missed += 1;
      continue;
    }
    const caught = violations(planted, PR);
    console.log(`${caught.length ? "CAUGHT" : "MISSED"}  ${label}${caught.length ? ` -> ${caught[0]}` : ""}`);
    if (!caught.length) missed += 1;
  }
  const prCaught = violations(DAILY, PR + "\n      - run: echo ${{ secrets.ANTHROPIC_API_KEY }}\n");
  console.log(`${prCaught.length ? "CAUGHT" : "MISSED"}  a secret in pr.yml`);
  if (!prCaught.length) missed += 1;
  if (missed) {
    console.error(`\n${missed} planted violation(s) not caught; this check has stopped measuring.`);
    process.exit(1);
  }
}

const found = violations(DAILY, PR);
if (found.length) {
  for (const f of found) console.error(`FAIL  ${f}`);
  process.exit(1);
}
console.log("publishing workflow: no install step or check holds a secret; checks block and precede the funnel.");
