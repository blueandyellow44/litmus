// Split article text into paragraphs. MUST match the server's split rule
// (litmus-server/src/lib/paragraphs.ts) — rawText carries paragraph breaks as
// "\n\n" and the scorer's [P#] indices are numbered against this exact split.
// The excerpt itself is selected server-side; this is used to render the full
// body as paragraphs in the article reader.
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
