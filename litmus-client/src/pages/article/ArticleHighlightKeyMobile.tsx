// The highlight key, composed for a phone: each mark on its own row at a
// readable size, directly above the excerpt it decodes. The samples use the
// same classes HighlightedText paints with, and the same words as the desktop
// key (HIGHLIGHT_KEY_LABEL).

import { HIGHLIGHT_CLASS, HIGHLIGHT_KEY_LABEL } from "../../lib/highlight.ts";

export function ArticleHighlightKeyMobile() {
  return (
    <div className="font-sans text-[16px] leading-[1.6] text-ink2 flex flex-col gap-1">
      <span className="text-micro uppercase font-semibold text-ink3">Key</span>
      <span>
        <mark className={HIGHLIGHT_CLASS.loaded}>{HIGHLIGHT_KEY_LABEL.loaded}</mark>
      </span>
      <span>
        <mark className={HIGHLIGHT_CLASS.grounded}>{HIGHLIGHT_KEY_LABEL.grounded}</mark>
      </span>
    </div>
  );
}
