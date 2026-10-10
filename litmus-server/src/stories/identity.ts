// Story identity: the id, the slug and the membership hash.
//
// A story id is minted once and never regenerated. The old clusters table
// replaced every row on every run, so each run renumbered every story and
// anything keyed to a story id (the hand-written receipts) was orphaned. An id
// here is "st_" plus a ULID: 48 bits of creation time then 80 random bits, in
// Crockford base32, so ids sort by creation and cannot collide in practice.

import { createHash, randomBytes } from "node:crypto";
import type { StoryMemberDTO, StoryMemberKind } from "../api/storyTypes.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BITS_PER_CHAR = 5;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
const RANDOM_BYTES = 10; // 80 bits, exactly RANDOM_CHARS * BITS_PER_CHAR
const MAX_ULID_TIME_MS = 2 ** 48 - 1;

export const STORY_ID_PREFIX = "st_";
// Mirrors the stories_id_format CHECK constraint.
export const STORY_ID_PATTERN = /^st_[0-9A-HJKMNP-TV-Z]{26}$/;
// Mirrors the stories_slug_format CHECK constraint.
export const STORY_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Long enough to read as the headline in a URL, short enough to share.
export const STORY_SLUG_MAX_WORDS_CHARS = 60;
// Random characters from the id's tail, so two stories with the same headline
// still get distinct slugs.
const SLUG_ID_TAIL_CHARS = 6;

export function mintStoryId(nowMs: number = Date.now(), random: Uint8Array = randomBytes(RANDOM_BYTES)): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > MAX_ULID_TIME_MS) {
    throw new Error(`mintStoryId: time ${nowMs} is outside the 48-bit millisecond range`);
  }
  if (random.length !== RANDOM_BYTES) {
    throw new Error(`mintStoryId: needs exactly ${RANDOM_BYTES} random bytes, got ${random.length}`);
  }

  const timeChars: string[] = new Array(TIME_CHARS);
  let t = nowMs;
  for (let i = TIME_CHARS - 1; i >= 0; i--) {
    timeChars[i] = CROCKFORD_BASE32[t % 32]!;
    t = Math.floor(t / 32);
  }

  let randomChars = "";
  let buffer = 0;
  let bufferedBits = 0;
  for (const byte of random) {
    buffer = (buffer << 8) | byte;
    bufferedBits += 8;
    while (bufferedBits >= BITS_PER_CHAR) {
      bufferedBits -= BITS_PER_CHAR;
      randomChars += CROCKFORD_BASE32[(buffer >> bufferedBits) & 0b11111]!;
    }
    // Keep only the bits not yet emitted, so the shift above never overflows.
    buffer &= (1 << bufferedBits) - 1;
  }
  if (randomChars.length !== RANDOM_CHARS) {
    throw new Error(`mintStoryId: encoded ${randomChars.length} random characters, expected ${RANDOM_CHARS}`);
  }

  return `${STORY_ID_PREFIX}${timeChars.join("")}${randomChars}`;
}

export function storySlug(headline: string, storyId: string): string {
  if (!STORY_ID_PATTERN.test(storyId)) {
    throw new Error(`storySlug: "${storyId}" is not a story id`);
  }
  const tail = storyId.slice(-SLUG_ID_TAIL_CHARS).toLowerCase();

  let words = headline
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents off, so "Zelenskyy's Pétition" keeps its letters
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");

  if (words.length > STORY_SLUG_MAX_WORDS_CHARS) {
    const cut = words.slice(0, STORY_SLUG_MAX_WORDS_CHARS);
    const lastBreak = cut.lastIndexOf("-");
    // Cut on a word boundary when there is one; a single enormous word is cut hard.
    words = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).replace(/-+$/, "");
  }

  return words === "" ? `story-${tail}` : `${words}-${tail}`;
}

export type StoryMemberRole = StoryMemberDTO["role"];

export interface MembershipEntry {
  articleId: number;
  role: StoryMemberRole;
  kind: StoryMemberKind;
}

// A stable fingerprint of who is in a story and in what capacity. The
// assessment is regenerated only when this changes. Kind is part of it because
// a headline-only member that becomes readable changes what the assessment can
// draw on; order is not, because the same membership read back in a different
// order is the same story.
export function membershipHash(members: readonly MembershipEntry[]): string {
  if (members.length === 0) {
    throw new Error("membershipHash: a story with no members has nothing to fingerprint");
  }
  const seen = new Set<number>();
  for (const m of members) {
    if (!Number.isSafeInteger(m.articleId) || m.articleId <= 0) {
      throw new Error(`membershipHash: article id ${m.articleId} is not a positive integer`);
    }
    if (seen.has(m.articleId)) {
      throw new Error(`membershipHash: article ${m.articleId} appears twice; a story holds an article once`);
    }
    seen.add(m.articleId);
  }
  const canonical = [...members]
    .sort((a, b) => a.articleId - b.articleId)
    .map((m) => `${m.articleId}:${m.role}:${m.kind}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}
