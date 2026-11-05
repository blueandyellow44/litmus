// Builds this week's letter from a published snapshot and, with --draft, posts
// it to Buttondown as a DRAFT for Max to read and send (Max, 2026-10-11:
// Buttondown, weekly, pipeline-drafted, Max-read). This script never sends: the
// status is always "draft", and a reply that says anything else is a failure.
//
// Run: ./litmus-server/node_modules/.bin/tsx scripts/weekly-letter.ts [snapshot.json] [--out file.md] [--draft]
//
// Without --draft it prints the issue, or writes it to --out. --draft needs
// BUTTONDOWN_API_KEY in the environment; the key is never printed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { letterSubject, pickLetterStories, renderLetter } from "../litmus-client/src/lib/letter.js";
import type { StoryDTO } from "../litmus-client/src/lib/storyTypes.js";

const BUTTONDOWN_EMAILS = "https://api.buttondown.com/v1/emails";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const draft = args.includes("--draft");
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const file = args.find((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1)) ?? join(ROOT, "litmus-client", "src", "demo", "snapshot.json");

function fail(message: string): never {
  console.error(`weekly-letter: ${message}`);
  process.exit(1);
}

if (outAt >= 0 && !out) fail("--out needs a file path");
// Every issue keeps its own file: an earlier draft is never written over.
if (out && existsSync(out)) fail(`${out} already exists; choose a new name`);

const snapshot = JSON.parse(readFileSync(file, "utf8")) as { stories?: StoryDTO[]; edition?: { buildCompletedAt?: string } };
if (!Array.isArray(snapshot.stories)) fail(`${file} has no stories array`);
const builtAt = snapshot.edition?.buildCompletedAt;
if (!builtAt) fail(`${file} has no edition build time`);

// A week with nothing to compare is a refusal with a reason, not a stack trace.
function build(stories: StoryDTO[], at: string) {
  try {
    const chosen = pickLetterStories(stories, at);
    return { picked: chosen, subject: letterSubject(at), body: renderLetter(chosen) };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
const { picked, subject, body } = build(snapshot.stories, builtAt);

if (out) writeFileSync(out, `# ${subject}\n\n${body}`);
else if (!draft) console.log(`# ${subject}\n\n${body}`);

// Posts the issue as a draft. The status is stated, not left to the API's
// default, and the reply is checked: a draft is the only acceptable outcome.
async function postDraft(): Promise<void> {
  const key = process.env.BUTTONDOWN_API_KEY;
  if (!key) fail("--draft needs BUTTONDOWN_API_KEY");
  const res = await fetch(BUTTONDOWN_EMAILS, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ subject, body, status: "draft" }),
  });
  if (!res.ok) fail(`Buttondown refused the draft: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const created = (await res.json()) as { id?: string; status?: string };
  if (created.status !== "draft") fail(`Buttondown created the email as "${created.status}", not a draft (id ${created.id}); check it now`);
  console.error(`weekly-letter: draft ${created.id} created`);
}

(draft ? postDraft() : Promise.resolve())
  .then(() => console.error(JSON.stringify({ stories: picked.length, builtAt, subject, drafted: draft, out: out ?? null })))
  .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
