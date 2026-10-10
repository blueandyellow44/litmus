// Prints how many stories the front page will show for a snapshot, using the
// client's own filters (lib/useStories.ts applies the same three), so the
// edition-size gate counts what a reader sees and not what the database holds.
//
// Run: ./litmus-server/node_modules/.bin/tsx scripts/front-page-count.ts [snapshot.json]

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inPoliticalScope, inTodaysPaper, withScoredReport } from "../litmus-client/src/lib/storyModel.js";
import type { StoryDTO } from "../litmus-client/src/lib/storyTypes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2] ?? join(ROOT, "litmus-client", "src", "demo", "snapshot.json");
const snapshot = JSON.parse(readFileSync(file, "utf8")) as { stories?: StoryDTO[]; edition?: { buildCompletedAt?: string } };
if (!Array.isArray(snapshot.stories)) {
  console.error(`front-page-count: ${file} has no stories array`);
  process.exit(1);
}
const inScope = withScoredReport(inPoliticalScope(snapshot.stories));
const builtAt = snapshot.edition?.buildCompletedAt ?? "";
const shown = builtAt ? inTodaysPaper(inScope, builtAt) : inScope;
console.log(JSON.stringify({ stories: shown.length, builtAt }));
