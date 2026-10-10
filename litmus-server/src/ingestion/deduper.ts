import { createHash } from "node:crypto";

// Build a content hash that collapses syndicated wire stories. AP and Reuters
// articles get republished by dozens of outlets — same body text, different URLs.
// Hashing on (normalized title + first 500 chars of body) catches them without
// being fooled by minor headline tweaks or appended editor notes.
//
// Normalization: lowercase, collapse whitespace, strip punctuation. We do NOT
// strip stopwords — that would create false positives.
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function contentHash(title: string, body: string): string {
  const normTitle = normalize(title);
  const normBody = normalize(body).slice(0, 500);
  return createHash("sha256").update(normTitle + "\n" + normBody).digest("hex");
}
