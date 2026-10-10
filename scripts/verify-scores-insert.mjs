// Verifies that insertScore's raw SQL agrees with itself. Free: no database.
//   node scripts/verify-scores-insert.mjs
//
// insertScore is a hand-written INSERT with a positional parameter list. Adding
// a column means touching three places that must stay in lockstep: the column
// list, the VALUES placeholders, and the JS argument array. TypeScript cannot
// see inside a template literal, so a mismatch there typechecks cleanly and
// then fails at runtime on the first real score — after a paid model call has
// already been made. This asserts the three agree by parsing the source.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "litmus-server/src/db/repos/scoresRepo.ts");
const src = readFileSync(SRC, "utf-8");

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// The INSERT statement, from "INSERT INTO scores" to the closing backtick.
const sqlMatch = src.match(/`(INSERT INTO scores[\s\S]*?)`/);
if (!sqlMatch) {
  console.log("FAIL  could not locate the INSERT INTO scores statement in scoresRepo.ts");
  process.exit(1);
}
const sql = sqlMatch[1];

// Column list: the parenthesised block after "INSERT INTO scores".
const colsMatch = sql.match(/INSERT INTO scores\s*\(([\s\S]*?)\)\s*VALUES/);
const columns = colsMatch
  ? colsMatch[1].split(",").map((c) => c.trim()).filter(Boolean)
  : [];

// Placeholders: highest $N, and confirm 1..N all appear exactly once.
const placeholderNums = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
const maxPlaceholder = placeholderNums.length ? Math.max(...placeholderNums) : 0;
const seen = new Set(placeholderNums);
const missing = [];
for (let i = 1; i <= maxPlaceholder; i++) if (!seen.has(i)) missing.push(i);
const duplicated = placeholderNums.filter((n, i) => placeholderNums.indexOf(n) !== i);

// Argument array: the bracketed block passed as pool.query's second argument,
// counted by top-level commas so nested calls like JSON.stringify(a, b) are safe.
const argsMatch = src.match(/ON CONFLICT \(article_id\) DO NOTHING`,\s*\[([\s\S]*?)\n\s*\],/);
let argCount = 0;
if (argsMatch) {
  let depth = 0;
  let current = "";
  const items = [];
  for (const ch of argsMatch[1]) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { items.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) items.push(current);
  argCount = items.filter((s) => s.trim().length > 0).length;
}

console.log(`columns=${columns.length}  placeholders=${maxPlaceholder}  args=${argCount}`);
check("column count equals placeholder count", columns.length === maxPlaceholder, `${columns.length} vs ${maxPlaceholder}`);
check("argument count equals placeholder count", argCount === maxPlaceholder, `${argCount} vs ${maxPlaceholder}`);
check("no placeholder gaps", missing.length === 0, missing.length ? `missing $${missing.join(", $")}` : "1..N contiguous");
check("no duplicated placeholders", duplicated.length === 0, duplicated.length ? `repeated $${[...new Set(duplicated)].join(", $")}` : "each used once");

// The three columns this fix exists to persist must actually be written.
for (const col of ["flags", "breakdown", "declared_band"]) {
  check(`writes ${col}`, columns.includes(col), columns.includes(col) ? "present" : "absent from the column list");
}

console.log(`\n${failures === 0 ? "OK" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
