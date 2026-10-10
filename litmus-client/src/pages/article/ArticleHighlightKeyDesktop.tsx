// The highlight key for the desktop evidence column head, one line: a KEY label,
// then a sample of each mark drawn with the same classes HighlightedText uses,
// so the key cannot drift from the marks it explains. Two states only (Quiet
// Reader brand.md section 4); there is no intensity ramp to explain any more.

import { HIGHLIGHT_CLASS, HIGHLIGHT_KEY_LABEL } from "../../lib/highlight.ts";

export function ArticleHighlightKeyDesktop() {
  return (
    <div className="font-sans text-[14px] leading-[1.6] text-ink2 flex items-baseline gap-x-3.5 gap-y-1 flex-wrap">
      <span className="text-micro uppercase font-semibold text-ink3">Key</span>
      <mark className={HIGHLIGHT_CLASS.loaded}>{HIGHLIGHT_KEY_LABEL.loaded}</mark>
      <mark className={HIGHLIGHT_CLASS.grounded}>{HIGHLIGHT_KEY_LABEL.grounded}</mark>
    </div>
  );
}
