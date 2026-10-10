// The slice of an article's body the scorer is actually shown.
//
// The old rule was `numbered.slice(0, MAX_BODY_CHARS)` — the first ~6,000
// characters and nothing else. That is fine for a 700-word report, which fits
// whole, and wrong for a long read in exactly the way that matters to this
// instrument: the counterpoint a piece buries, the paragraph where the register
// finally turns, and the closing characterization all live past the cut. The
// scorer then judged "sourcing" on a window that could not contain the missing
// side, and judged "structure" without seeing how the piece landed.
//
// So the window keeps a HEAD and a TAIL. Both are deterministic — no model call,
// no sampling, no randomness — and the paragraphs stay in document order with
// their [P#] tags intact, so `excerpt_paragraphs` indices returned against this
// window still resolve against the full article on the server side.
//
// Where paragraphs are dropped, an explicit marker says so. A silent join would
// read as one continuous passage and invite the model to score a transition
// that does not exist in the article.

// Roughly 1,500 words. The main per-call cost and latency lever; see
// batchRunner's concurrency note before raising it.
export const MAX_BODY_CHARS = 6000;

// How much of the budget the opening gets. The head carries the headline's
// follow-through, the lede, and the nut graf, which is where most of the
// framing signal is; the tail is a check on how the piece resolves. 70/30
// keeps the head at roughly what it had before while buying a real ending.
export const HEAD_SHARE = 0.7;

export const ELISION = "[… middle of the article omitted for length …]";

export interface ScoreWindow {
  body: string;
  // Paragraph indices actually shown, in document order. Exposed so a test — or
  // a future caller wanting to validate an excerpt anchor against what the
  // model could see — can ask rather than re-derive.
  includedIndices: number[];
  // True when the article fitted whole and nothing was dropped.
  complete: boolean;
}

// `paragraphs` is the article split into paragraphs, in order. The returned
// body is the [P#]-tagged text to hand the scorer.
export function buildScoreWindow(
  paragraphs: string[],
  maxChars: number = MAX_BODY_CHARS,
): ScoreWindow {
  const tagged = paragraphs.map((p, i) => `[P${i}] ${p}`);
  const SEP = "\n\n";

  // The whole article fits: no elision, no decisions to make.
  const whole = tagged.join(SEP);
  if (whole.length <= maxChars) {
    return { body: whole, includedIndices: paragraphs.map((_, i) => i), complete: true };
  }

  // A budget smaller than the marker itself cannot describe its own elision, so
  // it degrades to a plain head cut rather than emitting a body that is mostly
  // apology. Guard, not a normal path: MAX_BODY_CHARS is 6000.
  const budget = maxChars - (ELISION.length + SEP.length * 2);
  if (budget <= 0) {
    return { body: whole.slice(0, maxChars), includedIndices: [], complete: false };
  }

  const headBudget = Math.floor(budget * HEAD_SHARE);

  // Head: whole paragraphs from the top while they fit.
  const head: number[] = [];
  let headLen = 0;
  for (let i = 0; i < tagged.length; i++) {
    const cost = tagged[i]!.length + (head.length > 0 ? SEP.length : 0);
    if (headLen + cost > headBudget) break;
    head.push(i);
    headLen += cost;
  }
  // A first paragraph longer than the whole head budget would otherwise produce
  // an empty head and a window that starts mid-article. Take it truncated.
  const headTruncated = head.length === 0;
  if (headTruncated) head.push(0);

  // Tail: whole paragraphs from the bottom while the remaining budget allows,
  // never re-using one the head already holds.
  const tailBudget = budget - (headTruncated ? Math.min(tagged[0]!.length, headBudget) : headLen);
  const tail: number[] = [];
  let tailLen = 0;
  for (let i = tagged.length - 1; i > (head[head.length - 1] ?? 0); i--) {
    const cost = tagged[i]!.length + (tail.length > 0 ? SEP.length : 0);
    if (tailLen + cost > tailBudget) break;
    tail.unshift(i);
    tailLen += cost;
  }

  const headText = headTruncated
    ? tagged[0]!.slice(0, headBudget)
    : head.map((i) => tagged[i]!).join(SEP);

  // Nothing was actually dropped between head and tail — they meet — so the
  // marker would be a lie. This can happen when the tail budget swallows the
  // remainder.
  const contiguous =
    !headTruncated && tail.length > 0 && tail[0] === head[head.length - 1]! + 1;

  const parts = contiguous
    ? [headText, tail.map((i) => tagged[i]!).join(SEP)]
    : tail.length > 0
      ? [headText, ELISION, tail.map((i) => tagged[i]!).join(SEP)]
      : [headText, ELISION];

  return {
    body: parts.join(SEP),
    includedIndices: [...head, ...tail],
    complete: false,
  };
}
