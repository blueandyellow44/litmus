// Some feeds ship titles with HTML entities still encoded ("Kids&#039; Test
// Scores", "some bad things&#8217;"). Ingest decodes feed titles with this
// before they are stored; the client decodes titles already stored the same
// way (litmus-client/src/lib/entities.ts). One regex pass, so "&amp;#039;"
// becomes "&#039;" and is not decoded twice.
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  rsquo: "\u2019",
  lsquo: "\u2018",
  rdquo: "\u201d",
  ldquo: "\u201c",
  hellip: "\u2026",
  mdash: "\u2014",
  ndash: "\u2013",
};

export function decodeEntities(text: string): string {
  if (!text || !text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // An out-of-range or NUL code point is left as written, not turned into a
      // replacement character or a thrown RangeError.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}
