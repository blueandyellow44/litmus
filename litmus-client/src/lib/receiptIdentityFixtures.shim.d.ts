// scripts/receipt-identity-fixtures.mjs is plain JS shared with the plain-node
// publish gate (scripts/receipt-publish-gate-test.mjs), so it has no TS build
// of its own. A precise ambient module declaration keyed to the exact
// relative specifier did not get picked up by this project's module
// resolution, so this is a narrow wildcard instead, scoped to `.mjs` only —
// consumers annotate the shapes they pull out of CASES explicitly (see
// claims.test.ts), so this does not weaken type-checking anywhere but the
// one import boundary that genuinely crosses out of TypeScript.
declare module "*.mjs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const CASES: any;
  // scripts/stories-fixture.mjs: builds the story list from a snapshot's
  // clusters (storiesFixture.test.ts annotates what it pulls out).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function buildStories(snapshot: any, options?: any): any;
  export const FIXTURE_HEADLINE_ONLY_TITLE_PREFIX: string;
  export const FIXTURE_OUTLET_SUFFIX: string;
}
