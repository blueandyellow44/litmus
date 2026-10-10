// One identity per outlet across its sister feeds.
//
// The roster lists feeds, not outlets: "New York Times — Politics" and "New York
// Times — US" are two rows and one newsroom. Counting them as two outlets makes
// a story look more widely covered than it is and lets one newsroom fill two
// dots in the story matrix.
//
// sources/seed.json carries an explicit outletKey on every feed and is the
// authority, because a name alone cannot say that "BBC Sport" and "BBC News —
// World" are the same outlet. This derivation is the fallback for a row with no
// explicit key, and it is mirrored in SQL by migrations/0001_story_ledger.up.sql
// for the one-time backfill. The storiesRepo integration test proves the two
// agree over every seed name, so keep them changing together.

// Seed names put the feed's desk after a spaced em dash: "Outlet — Desk".
const FEED_DESK_SEPARATOR = " — ";

// Mirrors the sources_outlet_key_format CHECK constraint.
export const OUTLET_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Non-ASCII characters are stripped BEFORE lowercasing, never after. JavaScript
// lowercases some non-ASCII letters into ASCII ones (the Kelvin sign becomes
// "k"), and Postgres under a C locale does not, so lowercasing first would let
// this and the SQL backfill disagree on the same name.
export function outletKeyFromName(name: string): string | null {
  const outlet = name.split(FEED_DESK_SEPARATOR)[0] ?? "";
  const key = outlet
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
  return key === "" ? null : key;
}

// The key a source is stored with: its explicit key when it has one, which must
// be well formed, otherwise the derivation. Throws rather than writing a row the
// CHECK constraint would reject, so the error names the source.
export function resolveOutletKey(source: { name: string; outletKey?: string | null }): string {
  if (source.outletKey !== undefined && source.outletKey !== null) {
    if (!OUTLET_KEY_PATTERN.test(source.outletKey)) {
      throw new Error(
        `source "${source.name}" has an invalid outletKey "${source.outletKey}": ` +
          "use lowercase ASCII letters and digits joined by single hyphens",
      );
    }
    return source.outletKey;
  }
  const derived = outletKeyFromName(source.name);
  if (derived === null) {
    throw new Error(
      `source "${source.name}" has no outletKey and none can be derived from its name; ` +
        "add one to sources/seed.json",
    );
  }
  return derived;
}
