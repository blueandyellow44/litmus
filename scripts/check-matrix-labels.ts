// Every dot on every matrix has a label in the chart (Max, 2026-10-09: "they
// all need to be labeled in matrix"). Runs the client's own layout over the
// edition about to be published, at all three chart sizes, and reports any dot
// left for the line under the chart.
//
// This warns; it does not block. A dot the layout could not place is still
// named under its chart, and holding back the day's paper for one label would
// be the worse outcome. The warning is a GitHub annotation on the run, so a
// regression is visible the morning it happens.
//
// Run: ./litmus-server/node_modules/.bin/tsx scripts/check-matrix-labels.ts [snapshot.json]
//      ./litmus-server/node_modules/.bin/tsx scripts/check-matrix-labels.ts --prove-it-fails

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MATRIX_PRESETS, fitMatrix, unlabelledPoints, type FittedMatrix, type MatrixPresetName } from "../litmus-client/src/lib/storyMatrix.js";
import type { StoryDTO } from "../litmus-client/src/lib/storyTypes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROVE = process.argv.includes("--prove-it-fails");
const fileArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const file = fileArg ?? join(ROOT, "litmus-client", "src", "demo", "snapshot.json");

interface Miss { slug: string; preset: string; outlets: string[] }

function audit(stories: readonly StoryDTO[], fit: (s: StoryDTO, preset: MatrixPresetName) => FittedMatrix): { dots: number; misses: Miss[] } {
  let dots = 0;
  const misses: Miss[] = [];
  for (const story of stories) {
    for (const preset of Object.keys(MATRIX_PRESETS) as MatrixPresetName[]) {
      const fitted = fit(story, preset);
      if (preset === "front") dots += fitted.points.length;
      const left = unlabelledPoints(fitted.points, fitted.labels);
      if (left.length > 0) misses.push({ slug: story.slug, preset, outlets: left.map((p) => p.name) });
    }
  }
  return { dots, misses };
}

const snapshot = JSON.parse(readFileSync(file, "utf8")) as { stories?: StoryDTO[] };
if (!Array.isArray(snapshot.stories)) {
  console.error(`check-matrix-labels: ${file} has no stories array`);
  process.exit(1);
}

if (PROVE) {
  // Drop one label from the first chart that has any; the audit must see it.
  let dropped = false;
  const broken = audit(snapshot.stories, (s, preset) => {
    const fitted = fitMatrix(s.members, preset);
    if (dropped || fitted.labels.length === 0) return fitted;
    dropped = true;
    return { ...fitted, labels: fitted.labels.slice(1) };
  });
  if (!dropped) {
    console.error("check-matrix-labels --prove-it-fails: the snapshot has no labelled chart to break");
    process.exit(1);
  }
  if (broken.misses.length === 0) {
    console.error("check-matrix-labels --prove-it-fails: a dropped label went unnoticed");
    process.exit(1);
  }
  console.log(`check-matrix-labels: a dropped label is caught (${broken.misses[0]!.outlets.join(", ")} in ${broken.misses[0]!.slug})`);
} else {
  const { dots, misses } = audit(snapshot.stories, (s, preset) => fitMatrix(s.members, preset));
  if (misses.length === 0) {
    console.log(`check-matrix-labels: ${dots} dots across ${snapshot.stories.length} stories, every one labelled in its chart at all three sizes`);
  } else {
    for (const m of misses.slice(0, 10)) console.log(`  not labelled in chart: ${m.outlets.join(", ")} (${m.preset}, ${m.slug})`);
    console.log(`::warning title=Matrix labels::${misses.length} chart(s) have a dot with no label in the chart; first: ${misses[0]!.outlets.join(", ")} in ${misses[0]!.slug} (${misses[0]!.preset})`);
  }
}
